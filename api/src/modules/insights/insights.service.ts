import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { AccountType, FileDocument, FileRecord, FileStatus } from '../../db/schemas/file.schema';
import { Label, LabelDocument, LabelType } from '../../db/schemas/label.schema';
import {
  LabelRule,
  LabelRuleAccountType,
  LabelRuleApplyMode,
  LabelRuleDocument,
  LabelRuleDirection,
} from '../../db/schemas/label-rule.schema';
import { ParseJob, ParseJobDocument, ParseJobStatus } from '../../db/schemas/parse-job.schema';
import { ParsedStatement, ParsedStatementDocument, ParsedStatementStatus } from '../../db/schemas/parsed-statement.schema';
import { TransactionLabel, TransactionLabelDocument } from '../../db/schemas/transaction-label.schema';
import { TransactionDocument, TransactionRecord } from '../../db/schemas/transaction.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { CreateLabelRuleDto } from './dto/create-label-rule.dto';
import { SessionsService } from '../sessions/sessions.service';
import { ParsedTransactionDraft, StatementParserService } from './statement-parser.service';
import { StorageService } from '../storage/storage.service';

const MAX_INLINE_PARSE_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_PARSE_FILES_PER_REQUEST = 3;
const INLINE_PARSE_TIMEOUT_MS = 15000;
const PARSE_WORKER_POLL_INTERVAL_MS = 2000;
const PARSE_WORKER_MAX_JOBS_PER_TICK = 2;
const PARSE_WORKER_LEASE_MS = 45000;
const PARSE_JOB_MAX_ATTEMPTS = 5;
const PARSE_JOB_RETRY_BASE_DELAY_MS = 5000;
const PARSE_JOB_RETRY_MAX_DELAY_MS = 60000;
const SYSTEM_PAYCHECK_LABEL_NAME = 'PAYCHECK';

interface QueueParseItem {
  fileId: string;
  status: ParsedStatementStatus;
}

interface DeferredParseItem {
  fileId: string;
  reason: string;
}

interface ParseCandidateFile {
  _id: Types.ObjectId;
  fileId?: string;
  accountType?: AccountType;
  mimeType?: string;
  s3Bucket?: string;
  s3Key?: string;
  byteSize?: number;
}

interface PendingParsedStatementRow {
  sessionId: string;
  fileId: string;
}

export interface QueueParseResponse {
  queued: QueueParseItem[];
  skipped: string[];
  deferred: DeferredParseItem[];
}

export interface LabelResponse {
  id: string;
  ownerEmail: string;
  name: string;
  type: LabelType;
  isIncome: boolean;
  color?: string;
  createdAt?: string;
}

interface TransactionLabelLookupRow {
  transactionId: string;
  labelId: string;
}

interface LabelRuleLookupRow {
  labelId: string;
  applyMode: LabelRuleApplyMode;
  match?: {
    descriptionContains?: string[];
    descriptionRegex?: string;
    merchant?: string;
    amountEquals?: number;
    amountMin?: number;
    amountMax?: number;
    direction?: LabelRuleDirection;
    accountType?: LabelRuleAccountType;
  };
}

interface SuggestedLabelRow {
  labelId: string;
  applyMode: LabelRuleApplyMode;
}

interface TransactionRuleMatchContext {
  normalizedDescription: string;
  rawDescription: string;
  normalizedMerchant: string;
  amount: number | null;
  direction: LabelRuleDirection | null;
  accountType?: AccountType;
}

export interface AttachLabelResponse {
  attached: boolean;
  transactionId: string;
  labelId: string;
}

export interface RemoveLabelResponse {
  removed: boolean;
  transactionId: string;
  labelId: string;
}

export interface LabelRuleResponse {
  id: string;
  ownerEmail: string;
  labelId: string;
  match: {
    descriptionContains?: string[];
    descriptionRegex?: string;
    merchant?: string;
    amountEquals?: number;
    amountMin?: number;
    amountMax?: number;
    direction?: LabelRuleDirection;
    accountType?: LabelRuleAccountType;
  };
  applyMode: LabelRuleApplyMode;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable()
export class InsightsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InsightsService.name);
  private readonly parseWorkerId = `parse-worker-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private parseWorkerTimer: NodeJS.Timeout | null = null;
  private isParseWorkerTickRunning = false;

  constructor(
    @InjectModel(FileRecord.name)
    private readonly filesModel: Model<FileDocument>,
    @InjectModel(ParsedStatement.name)
    private readonly parsedStatementsModel: Model<ParsedStatementDocument>,
    @InjectModel(TransactionRecord.name)
    private readonly transactionsModel: Model<TransactionDocument>,
    @InjectModel(Label.name)
    private readonly labelsModel: Model<LabelDocument>,
    @InjectModel(TransactionLabel.name)
    private readonly transactionLabelsModel: Model<TransactionLabelDocument>,
    @InjectModel(LabelRule.name)
    private readonly labelRulesModel: Model<LabelRuleDocument>,
    private readonly sessionsService: SessionsService,
    private readonly statementParserService: StatementParserService,
    private readonly storageService: StorageService,
    @Optional()
    @InjectModel(ParseJob.name)
    private readonly parseJobsModel?: Model<ParseJobDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.parseJobsModel) {
      return;
    }

    await this.seedMissingParseJobsForPendingStatements();
    this.startParseWorker();
  }

  onModuleDestroy(): void {
    this.stopParseWorker();
  }

  private startParseWorker(): void {
    if (this.parseWorkerTimer) {
      return;
    }

    this.parseWorkerTimer = setInterval(() => {
      void this.runParseWorkerTick();
    }, PARSE_WORKER_POLL_INTERVAL_MS);

    void this.runParseWorkerTick();
  }

  private stopParseWorker(): void {
    if (!this.parseWorkerTimer) {
      return;
    }

    clearInterval(this.parseWorkerTimer);
    this.parseWorkerTimer = null;
  }

  private async runParseWorkerTick(): Promise<void> {
    if (!this.parseJobsModel || this.isParseWorkerTickRunning) {
      return;
    }

    this.isParseWorkerTickRunning = true;
    try {
      for (let index = 0; index < PARSE_WORKER_MAX_JOBS_PER_TICK; index += 1) {
        const claimedJob = await this.claimNextParseJob();
        if (!claimedJob) {
          break;
        }

        await this.processClaimedParseJob(claimedJob);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown parse worker error.';
      this.logger.warn(`Parse worker tick failed: ${reason}`);
    } finally {
      this.isParseWorkerTickRunning = false;
    }
  }

  private async claimNextParseJob(): Promise<ParseJobDocument | null> {
    if (!this.parseJobsModel) {
      return null;
    }

    const now = new Date();
    return this.parseJobsModel.findOneAndUpdate(
      {
        nextRunAt: { $lte: now },
        $or: [
          { status: ParseJobStatus.Pending },
          {
            status: ParseJobStatus.Processing,
            leaseExpiresAt: { $lte: now },
          },
        ],
      },
      {
        $set: {
          status: ParseJobStatus.Processing,
          lockedBy: this.parseWorkerId,
          leaseExpiresAt: new Date(Date.now() + PARSE_WORKER_LEASE_MS),
          startedAt: now,
          completedAt: undefined,
        },
        $inc: { attempts: 1 },
      },
      {
        sort: { priority: -1, nextRunAt: 1, createdAt: 1 },
        returnDocument: 'after',
      },
    ).exec();
  }

  private async processClaimedParseJob(job: ParseJobDocument): Promise<void> {
    const attempts = typeof job.attempts === 'number' ? job.attempts : 1;
    const maxAttempts = typeof job.maxAttempts === 'number' ? job.maxAttempts : PARSE_JOB_MAX_ATTEMPTS;
    const sessionId = job.sessionId;
    const fileId = job.fileId;

    if (!sessionId || !fileId) {
      await this.markParseJobAsFailed(job, 'Parse job is missing required session or file identifier.');
      return;
    }

    if (attempts > maxAttempts) {
      await this.markParseJobAsFailed(job, `Exceeded max attempts (${maxAttempts}).`);
      return;
    }

    try {
      await this.parsedStatementsModel.updateOne(
        { fileId },
        {
          $set: {
            sessionId,
            fileId,
            status: ParsedStatementStatus.Processing,
            parserVersion: this.statementParserService.getParserVersion(),
            confidence: { overall: 0, notes: [] },
          },
          $setOnInsert: {
            statementMeta: { currency: 'USD' },
            totals: {},
          },
        },
        { upsert: true },
      ).exec();

      const file = await this.findParseCandidateFile(sessionId, fileId);
      if (!file) {
        await this.markParsedStatementFailure(
          sessionId,
          fileId,
          'File not found or no longer uploaded for background parsing.',
        );
        await this.markParseJobAsFailed(job, 'File not found or not in uploaded status.');
        return;
      }

      await this.parseAndStoreStatementForFile(sessionId, fileId, file);
      await this.markParseJobAsCompleted(job);
    } catch (error) {
      await this.handleParseJobProcessingError(job, error, attempts, maxAttempts);
    }
  }

  private async handleParseJobProcessingError(
    job: ParseJobDocument,
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : 'Failed to process background parse job.';
    this.logger.warn(`Background parse failed for fileId=${job.fileId}: ${reason}`);

    if (!this.parseJobsModel) {
      return;
    }

    if (attempts >= maxAttempts) {
      await this.markParsedStatementFailure(
        job.sessionId,
        job.fileId,
        `Background parsing failed after ${attempts} attempts.`,
      );
      await this.markParseJobAsFailed(job, reason);
      return;
    }

    const retryDelayMs = this.getParseJobRetryDelayMs(attempts);
    await this.parseJobsModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ParseJobStatus.Pending,
          nextRunAt: new Date(Date.now() + retryDelayMs),
          lockedBy: undefined,
          leaseExpiresAt: undefined,
          lastError: reason,
          completedAt: undefined,
        },
      },
    ).exec();

    await this.parsedStatementsModel.updateOne(
      { fileId: job.fileId },
      {
        $set: {
          sessionId: job.sessionId,
          fileId: job.fileId,
          status: ParsedStatementStatus.Pending,
          parserVersion: this.statementParserService.getParserVersion(),
          confidence: {
            overall: 0,
            notes: [`Retrying parse in ${Math.ceil(retryDelayMs / 1000)}s.`],
          },
        },
        $setOnInsert: {
          statementMeta: { currency: 'USD' },
          totals: {},
        },
      },
      { upsert: true },
    ).exec();
  }

  private getParseJobRetryDelayMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    const delay = PARSE_JOB_RETRY_BASE_DELAY_MS * (2 ** exponent);
    return Math.min(PARSE_JOB_RETRY_MAX_DELAY_MS, delay);
  }

  private async markParseJobAsCompleted(job: ParseJobDocument): Promise<void> {
    if (!this.parseJobsModel) {
      return;
    }

    await this.parseJobsModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ParseJobStatus.Completed,
          completedAt: new Date(),
          nextRunAt: new Date(),
          lockedBy: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
        },
      },
    ).exec();
  }

  private async markParseJobAsFailed(job: ParseJobDocument, reason: string): Promise<void> {
    if (!this.parseJobsModel) {
      return;
    }

    await this.parseJobsModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ParseJobStatus.Failed,
          completedAt: new Date(),
          nextRunAt: new Date(),
          lockedBy: undefined,
          leaseExpiresAt: undefined,
          lastError: reason,
        },
      },
    ).exec();
  }

  private async findParseCandidateFile(
    sessionId: string,
    fileId: string,
  ): Promise<ParseCandidateFile | null> {
    const fileIdOrFilters: Array<Record<string, unknown>> = [{ fileId }];
    if (isValidObjectId(fileId)) {
      fileIdOrFilters.push({ _id: new Types.ObjectId(fileId) });
    }

    return this.filesModel.findOne({
      sessionId,
      status: FileStatus.Uploaded,
      $or: fileIdOrFilters,
    }).select({
      _id: 1,
      fileId: 1,
      accountType: 1,
      mimeType: 1,
      s3Bucket: 1,
      s3Key: 1,
      byteSize: 1,
    }).lean<ParseCandidateFile>().exec();
  }

  private async seedMissingParseJobsForPendingStatements(): Promise<void> {
    if (!this.parseJobsModel) {
      return;
    }

    const pendingRows = await this.parsedStatementsModel.find({
      status: ParsedStatementStatus.Pending,
    }).select({
      sessionId: 1,
      fileId: 1,
      _id: 0,
    }).lean<PendingParsedStatementRow[]>().exec();

    if (pendingRows.length === 0) {
      return;
    }

    await this.parseJobsModel.bulkWrite(
      pendingRows.map((row) => ({
        updateOne: {
          filter: {
            sessionId: row.sessionId,
            fileId: row.fileId,
          },
          update: {
            $setOnInsert: {
              sessionId: row.sessionId,
              fileId: row.fileId,
              status: ParseJobStatus.Pending,
              attempts: 0,
              maxAttempts: PARSE_JOB_MAX_ATTEMPTS,
              priority: 0,
              nextRunAt: new Date(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  private async enqueueDeferredParseJobs(
    sessionId: string,
    deferredItems: DeferredParseItem[],
  ): Promise<void> {
    if (!this.parseJobsModel || deferredItems.length === 0) {
      return;
    }

    const now = new Date();
    await this.parseJobsModel.bulkWrite(
      deferredItems.map((item) => ({
        updateOne: {
          filter: {
            sessionId,
            fileId: item.fileId,
          },
          update: {
            $set: {
              sessionId,
              fileId: item.fileId,
              status: ParseJobStatus.Pending,
              attempts: 0,
              maxAttempts: PARSE_JOB_MAX_ATTEMPTS,
              priority: 0,
              nextRunAt: now,
              lockedBy: undefined,
              leaseExpiresAt: undefined,
              completedAt: undefined,
              lastError: item.reason,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  private async clearParseJobs(
    sessionId: string,
    fileIds: string[],
  ): Promise<void> {
    if (!this.parseJobsModel || fileIds.length === 0) {
      return;
    }

    await this.parseJobsModel.deleteMany({
      sessionId,
      fileId: { $in: fileIds },
    }).exec();
  }

  async queueParseForSession(
    sessionId: string,
    fileIds: string[],
    user: AccessTokenPayload,
  ): Promise<QueueParseResponse> {
    await this.sessionsService.getActiveSessionById(sessionId, user);

    const requestedFileIds = [...new Set((fileIds ?? []).map((value) => value.trim()).filter(Boolean))];
    if (requestedFileIds.length === 0) {
      return {
        queued: [],
        skipped: [],
        deferred: [],
      };
    }

    const objectIds = requestedFileIds
      .filter((fileId) => isValidObjectId(fileId))
      .map((fileId) => new Types.ObjectId(fileId));
    const fileIdOrFilters: Array<Record<string, unknown>> = [{ fileId: { $in: requestedFileIds } }];
    if (objectIds.length > 0) {
      fileIdOrFilters.push({ _id: { $in: objectIds } });
    }

    const matchingFiles = await this.filesModel.find({
      sessionId,
      status: FileStatus.Uploaded,
      $or: fileIdOrFilters,
    }).select({
      _id: 1,
      fileId: 1,
      accountType: 1,
      mimeType: 1,
      s3Bucket: 1,
      s3Key: 1,
      byteSize: 1,
    }).lean<ParseCandidateFile[]>().exec();

    const queuedFileIdSet = new Set<string>();
    const matchedRequestedSet = new Set<string>();
    for (const file of matchingFiles) {
      const canonicalFileId = file.fileId?.trim() || file._id.toString();
      queuedFileIdSet.add(canonicalFileId);
      matchedRequestedSet.add(canonicalFileId);
      matchedRequestedSet.add(file._id.toString());
      if (file.fileId) {
        matchedRequestedSet.add(file.fileId);
      }
    }

    const queuedFileIds = [...queuedFileIdSet];
    const deferredItems: DeferredParseItem[] = [];
    if (queuedFileIds.length > 0) {
      const fileByCanonicalId = new Map<string, ParseCandidateFile>();
      for (const file of matchingFiles) {
        const canonicalFileId = file.fileId?.trim() || file._id.toString();
        fileByCanonicalId.set(canonicalFileId, file);
      }

      let inlineFileCount = 0;
      const inlineFileIds = new Set<string>();
      const pendingNoteByFileId = new Map<string, string>();

      for (const canonicalFileId of queuedFileIds) {
        const file = fileByCanonicalId.get(canonicalFileId);
        if (!file) {
          continue;
        }

        const deferredReason = this.getDeferredParseReason(file, inlineFileCount);
        if (deferredReason) {
          pendingNoteByFileId.set(canonicalFileId, deferredReason);
          deferredItems.push({
            fileId: canonicalFileId,
            reason: deferredReason,
          });
          continue;
        }

        inlineFileIds.add(canonicalFileId);
        inlineFileCount += 1;
      }

      await this.parsedStatementsModel.bulkWrite(
        queuedFileIds.map((fileId) => ({
          updateOne: {
            filter: { fileId },
            update: {
              $set: {
                sessionId,
                fileId,
                status: inlineFileIds.has(fileId)
                  ? ParsedStatementStatus.Processing
                  : ParsedStatementStatus.Pending,
                parserVersion: this.statementParserService.getParserVersion(),
                confidence: pendingNoteByFileId.has(fileId)
                  ? {
                      overall: 0,
                      notes: [pendingNoteByFileId.get(fileId)],
                    }
                  : { overall: 0, notes: [] },
              },
              $setOnInsert: {
                statementMeta: { currency: 'USD' },
                totals: {},
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      await this.enqueueDeferredParseJobs(sessionId, deferredItems);

      for (const canonicalFileId of inlineFileIds) {
        const file = fileByCanonicalId.get(canonicalFileId);
        if (!file) {
          continue;
        }
        await this.parseAndStoreStatementForFile(sessionId, canonicalFileId, file);
      }

      await this.clearParseJobs(sessionId, [...inlineFileIds]);
    }

    const skipped = requestedFileIds.filter((fileId) => !matchedRequestedSet.has(fileId));
    return {
      queued: queuedFileIds.map((fileId) => ({
        fileId,
        status: deferredItems.some((item) => item.fileId === fileId)
          ? ParsedStatementStatus.Pending
          : ParsedStatementStatus.Processing,
      })),
      skipped,
      deferred: deferredItems,
    };
  }

  private async parseAndStoreStatementForFile(
    sessionId: string,
    fileId: string,
    file: ParseCandidateFile,
  ): Promise<void> {
    if (!this.isSupportedAccountType(file.accountType)) {
      await this.markParsedStatementFailure(
        sessionId,
        fileId,
        'Unsupported or missing account type; only credit/checking/savings are currently parseable.',
      );
      return;
    }

    if (file.mimeType !== 'application/pdf') {
      await this.markParsedStatementFailure(
        sessionId,
        fileId,
        'Only PDF files can be parsed.',
      );
      return;
    }

    if (!file.s3Bucket || !file.s3Key) {
      await this.markParsedStatementFailure(
        sessionId,
        fileId,
        'Storage location is missing for this file.',
      );
      return;
    }

    try {
      const object = await this.storageService.getObject(file.s3Bucket, file.s3Key);
      const parsedDraft = await this.withTimeout(
        this.statementParserService.parsePdfBuffer(fileId, object.body, {
          accountType: file.accountType,
        }),
        INLINE_PARSE_TIMEOUT_MS,
      );

      await this.upsertTransactionsForFile(
        sessionId,
        fileId,
        file.accountType,
        parsedDraft.transactions,
      );

      const transactionCount = parsedDraft.transactions.length;
      const status = this.resolveParsedStatus(transactionCount, parsedDraft.confidence.overall);

      await this.parsedStatementsModel.updateOne(
        { fileId },
        {
          $set: {
            sessionId,
            fileId,
            status,
            parserVersion: this.statementParserService.getParserVersion(),
            extractedAt: new Date(),
            statementMeta: parsedDraft.statementMeta,
            totals: parsedDraft.totals,
            confidence: parsedDraft.confidence,
          },
        },
        { upsert: true },
      ).exec();
    } catch (error) {
      const isTimeout = this.isTimeoutError(error);
      const reason = error instanceof Error
        ? error.message
        : 'Failed to parse statement.';
      this.logger.warn(
        `Statement parse failed for fileId=${fileId}: ${reason}`,
      );
      await this.markParsedStatementFailure(
        sessionId,
        fileId,
        isTimeout
          ? `Statement parsing timed out after ${INLINE_PARSE_TIMEOUT_MS}ms.`
          : 'Failed to parse statement PDF. Please review the file format.',
      );
    }
  }

  private async upsertTransactionsForFile(
    sessionId: string,
    fileId: string,
    accountType: AccountType,
    transactions: ParsedTransactionDraft[],
  ): Promise<void> {
    if (transactions.length === 0) {
      return;
    }

    await this.transactionsModel.bulkWrite(
      transactions.map((transaction) => ({
        updateOne: {
          filter: { hash: transaction.hash },
          update: {
            $setOnInsert: {
              sessionId,
              fileId,
              accountType,
              txnDate: transaction.txnDate,
              ...(transaction.postDate ? { postDate: transaction.postDate } : {}),
              descriptionRaw: transaction.descriptionRaw,
              descriptionNormalized: transaction.descriptionNormalized,
              amount: transaction.amount,
              hash: transaction.hash,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  private async markParsedStatementFailure(
    sessionId: string,
    fileId: string,
    note: string,
  ): Promise<void> {
    await this.parsedStatementsModel.updateOne(
      { fileId },
      {
        $set: {
          sessionId,
          fileId,
          status: ParsedStatementStatus.Failed,
          parserVersion: this.statementParserService.getParserVersion(),
          extractedAt: new Date(),
          statementMeta: { currency: 'USD' },
          totals: {},
          confidence: {
            overall: 0,
            notes: [note],
          },
        },
      },
      { upsert: true },
    ).exec();
  }

  private resolveParsedStatus(
    transactionCount: number,
    overallConfidence: number,
  ): ParsedStatementStatus {
    if (transactionCount <= 0) {
      return ParsedStatementStatus.Failed;
    }

    if (overallConfidence >= 0.7) {
      return ParsedStatementStatus.Parsed;
    }

    return ParsedStatementStatus.NeedsReview;
  }

  private isSupportedAccountType(
    accountType: AccountType | undefined,
  ): accountType is AccountType {
    return (
      accountType === AccountType.Credit
      || accountType === AccountType.Checking
      || accountType === AccountType.Savings
    );
  }

  private getDeferredParseReason(
    file: ParseCandidateFile,
    inlineFileCount: number,
  ): string | null {
    if (typeof file.byteSize !== 'number' || file.byteSize <= 0) {
      return 'Queued for background parsing because file size is unavailable.';
    }

    if (file.byteSize > MAX_INLINE_PARSE_FILE_SIZE_BYTES) {
      const sizeMb = (file.byteSize / (1024 * 1024)).toFixed(2);
      return `Queued for background parsing because file is ${sizeMb}MB (inline max is 5MB).`;
    }

    if (inlineFileCount >= MAX_INLINE_PARSE_FILES_PER_REQUEST) {
      return 'Queued for background parsing because this request exceeded inline parse capacity.';
    }

    return null;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`PARSE_TIMEOUT:${timeoutMs}`));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('PARSE_TIMEOUT:');
  }

  async listParsedStatements(sessionId: string, user: AccessTokenPayload): Promise<Array<Record<string, unknown>>> {
    await this.sessionsService.getActiveSessionById(sessionId, user);
    const rows = await this.parsedStatementsModel.find({
      sessionId,
    }).sort({ updatedAt: -1, createdAt: -1 }).lean<Array<Record<string, unknown>>>().exec();
    return rows.map((row) => ({
      ...row,
      id: String(row._id),
    }));
  }

  async listTransactions(
    sessionId: string,
    fileId: string | undefined,
    user: AccessTokenPayload,
  ): Promise<Array<Record<string, unknown>>> {
    await this.sessionsService.getActiveSessionById(sessionId, user);

    const filter: {
      sessionId: string;
      fileId?: string;
    } = { sessionId };
    if (fileId?.trim()) {
      filter.fileId = fileId.trim();
    }

    const rows = await this.transactionsModel.find(filter)
      .sort({ txnDate: -1, _id: -1 })
      .lean<Array<Record<string, unknown>>>()
      .exec();

    const transactionIds = rows
      .map((row) => {
        const objectId = row._id;
        return typeof objectId === 'string' ? objectId : String(objectId ?? '');
      })
      .filter((id) => id.length > 0);

    const labelRows = transactionIds.length === 0
      ? []
      : await this.transactionLabelsModel.find({
          sessionId,
          transactionId: { $in: transactionIds },
        })
        .select({ transactionId: 1, labelId: 1, _id: 0 })
        .lean<TransactionLabelLookupRow[]>()
        .exec();

    const labelIdsByTransactionId = new Map<string, string[]>();
    for (const row of labelRows) {
      const current = labelIdsByTransactionId.get(row.transactionId) ?? [];
      current.push(row.labelId);
      labelIdsByTransactionId.set(row.transactionId, current);
    }

    const labelRules = await this.labelRulesModel.find({
      ownerEmail: user.email,
    })
      .select({ labelId: 1, applyMode: 1, match: 1, _id: 0 })
      .lean<LabelRuleLookupRow[]>()
      .exec();

    const labelRowsForOwner = await this.labelsModel.find({
      ownerEmail: user.email,
    })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId | string }>>()
      .exec();
    const validLabelIds = new Set(
      labelRowsForOwner.map((row) => String(row._id ?? '')).filter((value) => value.length > 0),
    );

    const filteredRules = labelRules.filter((rule) => validLabelIds.has(rule.labelId));
    const suggestedLabelsByTransactionId = new Map<string, SuggestedLabelRow[]>();
    if (filteredRules.length > 0) {
      for (const row of rows) {
        const transactionId = String(row._id);
        const attachedLabelIds = new Set(labelIdsByTransactionId.get(transactionId) ?? []);
        const suggestionByLabelId = new Map<string, LabelRuleApplyMode>();

        const context = this.buildTransactionRuleMatchContext(row);
        for (const rule of filteredRules) {
          if (attachedLabelIds.has(rule.labelId)) {
            continue;
          }
          if (!this.doesTransactionMatchRule(context, rule)) {
            continue;
          }

          const currentMode = suggestionByLabelId.get(rule.labelId);
          if (!currentMode || currentMode === LabelRuleApplyMode.Suggest) {
            suggestionByLabelId.set(rule.labelId, rule.applyMode ?? LabelRuleApplyMode.Suggest);
          }
        }

        if (suggestionByLabelId.size > 0) {
          const suggestions = [...suggestionByLabelId.entries()].map(([labelId, applyMode]) => ({
            labelId,
            applyMode,
          }));
          suggestedLabelsByTransactionId.set(transactionId, suggestions);
        }
      }
    }

    return rows.map((row) => ({
      ...row,
      id: String(row._id),
      labelIds: labelIdsByTransactionId.get(String(row._id)) ?? [],
      suggestedLabels: suggestedLabelsByTransactionId.get(String(row._id)) ?? [],
    }));
  }

  private buildTransactionRuleMatchContext(row: Record<string, unknown>): TransactionRuleMatchContext {
    const descriptionNormalized = this.normalizeRuleText(this.readString(row.descriptionNormalized));
    const descriptionRaw = this.readString(row.descriptionRaw) ?? '';
    const normalizedRawDescription = this.normalizeRuleText(descriptionRaw);
    const amount = this.readNumber(row.amount);

    return {
      normalizedDescription: descriptionNormalized || normalizedRawDescription,
      rawDescription: descriptionRaw,
      normalizedMerchant: this.normalizeRuleText(this.readString(row.merchantHint)),
      amount,
      direction: this.resolveDirectionFromAmount(amount),
      accountType: this.readAccountType(row.accountType),
    };
  }

  private doesTransactionMatchRule(
    context: TransactionRuleMatchContext,
    rule: LabelRuleLookupRow,
  ): boolean {
    const match = rule.match ?? {};

    const requiredAccountType = this.toAccountTypeFromRule(match.accountType);
    if (requiredAccountType && context.accountType !== requiredAccountType) {
      return false;
    }

    if (match.direction) {
      if (!context.direction || context.direction !== match.direction) {
        return false;
      }
    }

    if (typeof match.amountEquals === 'number') {
      if (context.amount === null || Math.abs(context.amount - match.amountEquals) >= 0.005) {
        return false;
      }
    }
    if (typeof match.amountMin === 'number') {
      if (context.amount === null || context.amount < match.amountMin) {
        return false;
      }
    }
    if (typeof match.amountMax === 'number') {
      if (context.amount === null || context.amount > match.amountMax) {
        return false;
      }
    }

    const merchantMatchText = this.normalizeRuleText(match.merchant);
    if (merchantMatchText && !context.normalizedMerchant.includes(merchantMatchText)) {
      return false;
    }

    const descriptionTokens = (match.descriptionContains ?? [])
      .map((token) => this.normalizeRuleText(token))
      .filter((token) => token.length > 0);
    if (
      descriptionTokens.length > 0
      && !descriptionTokens.every((token) => context.normalizedDescription.includes(token))
    ) {
      return false;
    }

    const regexPattern = this.readString(match.descriptionRegex);
    if (regexPattern) {
      try {
        const matcher = new RegExp(regexPattern, 'i');
        if (
          !matcher.test(context.normalizedDescription)
          && !matcher.test(context.rawDescription)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  private normalizeRuleText(value: string | undefined): string {
    if (!value) {
      return '';
    }
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readAccountType(value: unknown): AccountType | undefined {
    return value === AccountType.Credit
      || value === AccountType.Checking
      || value === AccountType.Savings
      ? value
      : undefined;
  }

  private toAccountTypeFromRule(value: LabelRuleAccountType | undefined): AccountType | null {
    if (value === LabelRuleAccountType.Credit) {
      return AccountType.Credit;
    }
    if (value === LabelRuleAccountType.Checking) {
      return AccountType.Checking;
    }
    if (value === LabelRuleAccountType.Savings) {
      return AccountType.Savings;
    }
    return null;
  }

  private resolveDirectionFromAmount(amount: number | null): LabelRuleDirection | null {
    if (amount === null || amount === 0) {
      return null;
    }
    return amount > 0 ? LabelRuleDirection.In : LabelRuleDirection.Out;
  }

  async listLabels(user: AccessTokenPayload): Promise<LabelResponse[]> {
    await this.ensureSystemPaycheckLabel(user.email);

    const rows = await this.labelsModel.find({
      ownerEmail: user.email,
    }).sort({ type: 1, name: 1, createdAt: -1 }).exec();

    return rows.map((row) => ({
      id: row._id.toString(),
      ownerEmail: row.ownerEmail,
      name: row.name,
      type: row.type,
      isIncome: row.isIncome,
      ...(row.color ? { color: row.color } : {}),
      ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
    }));
  }

  private async ensureSystemPaycheckLabel(ownerEmail: string): Promise<void> {
    await this.labelsModel.updateOne(
      {
        ownerEmail,
        type: LabelType.System,
        name: SYSTEM_PAYCHECK_LABEL_NAME,
      },
      {
        $set: {
          isIncome: true,
        },
        $setOnInsert: {
          ownerEmail,
          type: LabelType.System,
          name: SYSTEM_PAYCHECK_LABEL_NAME,
        },
      },
      { upsert: true },
    ).exec();
  }

  async createLabel(dto: CreateLabelDto, user: AccessTokenPayload): Promise<LabelResponse> {
    const created = await this.labelsModel.create({
      ownerEmail: user.email,
      name: dto.name.trim(),
      type: dto.type ?? LabelType.Custom,
      isIncome: dto.isIncome,
      color: dto.color?.trim(),
    });

    return {
      id: created._id.toString(),
      ownerEmail: created.ownerEmail,
      name: created.name,
      type: created.type,
      isIncome: created.isIncome,
      ...(created.color ? { color: created.color } : {}),
      ...(created.createdAt ? { createdAt: created.createdAt.toISOString() } : {}),
    };
  }

  async attachLabelToTransaction(
    transactionId: string,
    labelId: string,
    user: AccessTokenPayload,
  ): Promise<AttachLabelResponse> {
    if (!isValidObjectId(transactionId)) {
      throw new BadRequestException('Invalid transactionId.');
    }
    if (!isValidObjectId(labelId)) {
      throw new BadRequestException('Invalid labelId.');
    }

    const transaction = await this.transactionsModel.findById(transactionId).select({ sessionId: 1 }).exec();
    if (!transaction) {
      throw new NotFoundException('Transaction not found.');
    }
    await this.sessionsService.getActiveSessionById(transaction.sessionId, user);

    const label = await this.labelsModel.findOne({
      _id: labelId,
      ownerEmail: user.email,
    }).select({ _id: 1 }).exec();
    if (!label) {
      throw new NotFoundException('Label not found.');
    }

    await this.transactionLabelsModel.updateOne(
      { transactionId, labelId },
      {
        $setOnInsert: {
          sessionId: transaction.sessionId,
          transactionId,
          labelId,
        },
      },
      { upsert: true },
    ).exec();

    return {
      attached: true,
      transactionId,
      labelId,
    };
  }

  async removeLabelFromTransaction(
    transactionId: string,
    labelId: string,
    user: AccessTokenPayload,
  ): Promise<RemoveLabelResponse> {
    if (!isValidObjectId(transactionId)) {
      throw new BadRequestException('Invalid transactionId.');
    }
    if (!isValidObjectId(labelId)) {
      throw new BadRequestException('Invalid labelId.');
    }

    const transaction = await this.transactionsModel.findById(transactionId).select({ sessionId: 1 }).exec();
    if (transaction) {
      await this.sessionsService.getActiveSessionById(transaction.sessionId, user);
    }

    const result = await this.transactionLabelsModel.deleteOne({
      transactionId,
      labelId,
    }).exec();
    return {
      removed: result.deletedCount > 0,
      transactionId,
      labelId,
    };
  }

  async createLabelRule(dto: CreateLabelRuleDto, user: AccessTokenPayload): Promise<LabelRuleResponse> {
    if (!isValidObjectId(dto.labelId)) {
      throw new BadRequestException('Invalid labelId.');
    }

    const label = await this.labelsModel.findOne({
      _id: dto.labelId,
      ownerEmail: user.email,
    }).select({ _id: 1 }).exec();
    if (!label) {
      throw new NotFoundException('Label not found.');
    }

    const created = await this.labelRulesModel.create({
      ownerEmail: user.email,
      labelId: dto.labelId,
      match: dto.match ?? { accountType: LabelRuleAccountType.Any },
      applyMode: dto.applyMode ?? LabelRuleApplyMode.Suggest,
    });

    return {
      id: created._id.toString(),
      ownerEmail: created.ownerEmail,
      labelId: created.labelId,
      match: created.match ?? {},
      applyMode: created.applyMode,
      ...(created.createdAt ? { createdAt: created.createdAt.toISOString() } : {}),
      ...(created.updatedAt ? { updatedAt: created.updatedAt.toISOString() } : {}),
    };
  }

  async listLabelRules(user: AccessTokenPayload): Promise<LabelRuleResponse[]> {
    const rows = await this.labelRulesModel.find({
      ownerEmail: user.email,
    }).sort({ updatedAt: -1, createdAt: -1 }).exec();

    return rows.map((row) => ({
      id: row._id.toString(),
      ownerEmail: row.ownerEmail,
      labelId: row.labelId,
      match: row.match ?? {},
      applyMode: row.applyMode,
      ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    }));
  }
}
