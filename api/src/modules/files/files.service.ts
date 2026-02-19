import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import {
  FileCategory,
  FileDocument,
  FileRecord,
  FileStatus,
  StatementType,
} from '../../db/schemas/file.schema';
import { Session, SessionDocument, SessionStatus } from '../../db/schemas/session.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { StorageService } from '../storage/storage.service';

const DEFAULT_MAX_FILES_PER_UPLOAD = 10;
const DEFAULT_MAX_FILE_SIZE_MB = 15;
const ALLOWED_MIME_TYPE = 'application/pdf';
const FILE_UPLOAD_FAILED_MESSAGE = 'Failed to upload file to storage.';
const SESSION_NOT_FOUND_MESSAGE = 'Session not found.';
const FILE_NOT_FOUND_MESSAGE = 'File not found.';
const SESSION_ACCESS_FORBIDDEN_MESSAGE = 'Access to this session is not allowed.';
const DUPLICATE_FILE_NAME_REASON = 'A file with this name already exists in this session.';
const FILES_MOVE_EMPTY_MESSAGE = 'At least one file id is required for move.';
const STATEMENT_KEYWORDS: Record<Exclude<StatementType, StatementType.Unknown>, string[]> = {
  [StatementType.Credit]: [
    'credit card',
    'minimum payment',
    'statement balance',
    'credit limit',
  ],
  [StatementType.Checking]: [
    'checking account',
    'deposits',
    'withdrawals',
  ],
  [StatementType.Savings]: [
    'savings account',
    'interest earned',
  ],
};
const STATEMENT_TYPE_PRIORITY: Record<Exclude<StatementType, StatementType.Unknown>, number> = {
  [StatementType.Credit]: 3,
  [StatementType.Checking]: 2,
  [StatementType.Savings]: 1,
};
const CATEGORY_FROM_STATEMENT: Record<StatementType, FileCategory> = {
  [StatementType.Credit]: FileCategory.Credit,
  [StatementType.Checking]: FileCategory.Checking,
  [StatementType.Savings]: FileCategory.Savings,
  [StatementType.Unknown]: FileCategory.Unknown,
};

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith('\'') && trimmed.endsWith('\'');

  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export interface MultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
}

export interface UploadedFileItem {
  id: string;
  originalName: string;
  statementType: StatementType;
  category: FileCategory;
  autoDetectedType: StatementType;
  detectionConfidence: number;
  isLikelyStatement: boolean;
  s3Key: string;
  uploadedAt: string;
}

export interface RejectedFileItem {
  originalName: string;
  reason: string;
}

export interface UploadWarningItem {
  originalName: string;
  reason: string;
}

export interface UploadFilesResponse {
  uploaded: UploadedFileItem[];
  rejected: RejectedFileItem[];
  warnings: UploadWarningItem[];
}

export interface DetectFilePreviewItem {
  originalName: string;
  autoDetectedType: StatementType;
  detectionConfidence: number;
  isLikelyStatement: boolean;
}

export interface DetectFilesResponse {
  files: DetectFilePreviewItem[];
}

export interface SessionFileSummary {
  id: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  size: number;
  statementType: StatementType;
  category: FileCategory;
  status: FileStatus;
  s3Bucket: string;
  s3Key: string;
  uploadedAt: string;
}

export interface UpdateFileResponse {
  id: string;
  statementType: StatementType;
  confirmedByUser: boolean;
}

export interface DeleteFileResponse {
  deleted: boolean;
  fileId: string;
}

export interface MoveFilesToCategoryResponse {
  movedCount: number;
  category: FileCategory;
}

export interface RawFileResponse {
  fileName: string;
  mimeType: string;
  body: Buffer;
}

interface DetectionResult {
  autoDetectedType: StatementType;
  detectionConfidence: number;
  isLikelyStatement: boolean;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectModel(FileRecord.name)
    private readonly filesModel: Model<FileDocument>,
    @InjectModel(Session.name)
    private readonly sessionsModel: Model<SessionDocument>,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  async uploadFilesToSession(
    sessionId: string,
    user: AccessTokenPayload,
    files: MultipartFile[],
    statementTypeByName?: Map<string, StatementType>,
  ): Promise<UploadFilesResponse> {
    const normalizedFiles = files ?? [];
    if (normalizedFiles.length === 0) {
      throw new BadRequestException('At least one file must be provided.');
    }

    const session = await this.assertSessionAccess(sessionId, user, true);

    const maxFiles = this.getMaxFilesPerUpload();
    const maxFileSizeBytes = this.getMaxFileSizeBytes();
    const bucket = this.getRequiredEnv('S3_BUCKET_NAME');
    const metaMap = statementTypeByName ?? new Map<string, StatementType>();
    const statementTypeByFileNameKey = this.buildStatementTypeByFileNameKey(metaMap);
    const fileNameKeysInSession = await this.getExistingFileNameKeys(sessionId);

    const uploaded: UploadedFileItem[] = [];
    const rejected: RejectedFileItem[] = [];
    const warnings: UploadWarningItem[] = [];

    const acceptedBatch = normalizedFiles.slice(0, maxFiles);
    const skippedBatch = normalizedFiles.slice(maxFiles);
    for (const skippedFile of skippedBatch) {
      rejected.push({
        originalName: skippedFile.originalname,
        reason: `Exceeded max file count (${maxFiles}).`,
      });
    }

    for (const file of acceptedBatch) {
      const originalName = this.normalizeOriginalFileName(file.originalname);
      const fileNameKey = this.getFileNameKey(originalName);

      if (fileNameKeysInSession.has(fileNameKey)) {
        rejected.push({
          originalName,
          reason: DUPLICATE_FILE_NAME_REASON,
        });
        continue;
      }

      if (file.mimetype !== ALLOWED_MIME_TYPE) {
        rejected.push({
          originalName,
          reason: 'Only application/pdf files are accepted.',
        });
        continue;
      }

      if (file.size > maxFileSizeBytes) {
        rejected.push({
          originalName,
          reason: `File exceeds max size (${this.getMaxFileSizeMb()}MB).`,
        });
        continue;
      }

      if (!file.buffer) {
        rejected.push({
          originalName,
          reason: 'File payload is missing.',
        });
        continue;
      }

      // V1 requirement: run detection inline during the upload request (no queue/background worker).
      const detection = await this.detectStatementTypeFromPdf(file.buffer);
      const requestedStatementType = statementTypeByFileNameKey.get(fileNameKey) ?? StatementType.Unknown;
      const statementType = requestedStatementType === StatementType.Unknown
        ? detection.autoDetectedType
        : requestedStatementType;
      const category = this.resolveUploadCategory(statementType, session);
      fileNameKeysInSession.add(fileNameKey);
      const fileRecord = new this.filesModel({
        sessionId,
        originalName,
        mimeType: file.mimetype,
        size: file.size,
        statementType,
        category,
        autoDetectedType: detection.autoDetectedType,
        detectionConfidence: detection.detectionConfidence,
        isLikelyStatement: detection.isLikelyStatement,
        status: FileStatus.Pending,
        s3Bucket: bucket,
        s3Key: '',
      });

      const fileId = fileRecord._id.toString();
      fileRecord.s3Key = this.buildS3Key(sessionId, category, fileId, originalName);
      await fileRecord.save();

      try {
        await this.storageService.uploadObject({
          bucket,
          key: fileRecord.s3Key,
          body: file.buffer,
          contentType: file.mimetype,
        });

        fileRecord.status = FileStatus.Uploaded;
        fileRecord.uploadedAt = new Date();
        await fileRecord.save();

        uploaded.push({
          id: fileId,
          originalName: fileRecord.originalName,
          statementType: fileRecord.statementType,
          category: this.normalizeFileCategory(fileRecord.category),
          autoDetectedType: fileRecord.autoDetectedType,
          detectionConfidence: fileRecord.detectionConfidence,
          isLikelyStatement: fileRecord.isLikelyStatement,
          s3Key: fileRecord.s3Key,
          uploadedAt: new Date(fileRecord.uploadedAt).toISOString(),
        });

        if (!fileRecord.isLikelyStatement) {
          warnings.push({
            originalName: fileRecord.originalName,
            reason: 'No typical bank statement keywords were detected. Uploaded for manual review.',
          });
        }
      } catch (error) {
        await this.filesModel.updateOne(
          { _id: fileId },
          { $set: { status: FileStatus.Rejected } },
        ).exec();

        const reason = this.getUploadFailureReason(error);
        this.logger.error(
          `Failed to upload file "${originalName}" for session ${sessionId}: ${reason}`,
          error instanceof Error ? error.stack : String(error),
        );

        rejected.push({
          originalName,
          reason,
        });
      }
    }

    return { uploaded, rejected, warnings };
  }

  async detectFilesForSession(
    sessionId: string,
    user: AccessTokenPayload,
    files: MultipartFile[],
  ): Promise<DetectFilesResponse> {
    await this.assertSessionAccess(sessionId, user, true);

    const previews: DetectFilePreviewItem[] = [];
    for (const file of files ?? []) {
      const originalName = this.normalizeOriginalFileName(file.originalname);
      if (file.mimetype !== ALLOWED_MIME_TYPE || !file.buffer) {
        previews.push({
          originalName,
          autoDetectedType: StatementType.Unknown,
          detectionConfidence: 0,
          isLikelyStatement: false,
        });
        continue;
      }

      const detection = await this.detectStatementTypeFromPdf(file.buffer);
      previews.push({
        originalName,
        autoDetectedType: detection.autoDetectedType,
        detectionConfidence: detection.detectionConfidence,
        isLikelyStatement: detection.isLikelyStatement,
      });
    }

    return { files: previews };
  }

  async listSessionFiles(sessionId: string, user: AccessTokenPayload): Promise<SessionFileSummary[]> {
    await this.assertSessionAccess(sessionId, user, false);

    const files = await this.filesModel.find({
      sessionId,
      status: { $ne: FileStatus.Deleted },
    }).sort({ uploadedAt: -1, createdAt: -1 }).exec();

    return files.map((file) => ({
      id: file._id.toString(),
      sessionId: file.sessionId,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      statementType: file.statementType,
      category: this.normalizeFileCategory(file.category),
      status: file.status,
      s3Bucket: file.s3Bucket,
      s3Key: file.s3Key,
      uploadedAt: new Date(file.uploadedAt).toISOString(),
    }));
  }

  async updateFileStatementType(
    fileId: string,
    statementType: StatementType,
    user: AccessTokenPayload,
  ): Promise<UpdateFileResponse> {
    const file = await this.getAccessibleFile(fileId);
    await this.assertSessionAccess(file.sessionId, user, false);

    file.statementType = statementType;
    if (this.normalizeFileCategory(file.category) !== FileCategory.Unfiled) {
      file.category = CATEGORY_FROM_STATEMENT[statementType];
    }
    file.confirmedByUser = true;
    await file.save();

    return {
      id: file._id.toString(),
      statementType: file.statementType,
      confirmedByUser: file.confirmedByUser,
    };
  }

  async deleteFile(fileId: string, user: AccessTokenPayload): Promise<DeleteFileResponse> {
    const file = await this.getAccessibleFile(fileId);
    await this.assertSessionAccess(file.sessionId, user, false);

    await this.storageService.deleteObject(file.s3Bucket, file.s3Key);

    file.status = FileStatus.Deleted;
    file.deletedAt = new Date();
    await file.save();

    return {
      deleted: true,
      fileId: file._id.toString(),
    };
  }

  async moveFilesToCategory(
    sessionId: string,
    fileIds: string[],
    category: FileCategory,
    user: AccessTokenPayload,
  ): Promise<MoveFilesToCategoryResponse> {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new BadRequestException(FILES_MOVE_EMPTY_MESSAGE);
    }

    await this.assertSessionAccess(sessionId, user, false);
    const targetStatementType = this.getStatementTypeForMoveCategory(category);

    const validIds = [...new Set(fileIds.filter((id) => isValidObjectId(id)))];
    if (validIds.length === 0) {
      throw new BadRequestException(FILES_MOVE_EMPTY_MESSAGE);
    }

    const updateSet: {
      category: FileCategory;
      confirmedByUser: boolean;
      statementType?: StatementType;
    } = {
      category,
      confirmedByUser: true,
    };

    if (targetStatementType) {
      updateSet.statementType = targetStatementType;
    }

    const result = await this.filesModel.updateMany(
      {
        _id: { $in: validIds },
        sessionId,
        status: { $ne: FileStatus.Deleted },
      },
      {
        $set: updateSet,
      },
    ).exec();

    return {
      movedCount: result.modifiedCount ?? 0,
      category,
    };
  }

  async getRawFile(fileId: string, user: AccessTokenPayload): Promise<RawFileResponse> {
    const file = await this.getAccessibleFile(fileId);
    await this.assertSessionAccess(file.sessionId, user, false);

    const object = await this.storageService.getObject(file.s3Bucket, file.s3Key);
    return {
      fileName: file.originalName,
      mimeType: file.mimeType,
      body: object.body,
    };
  }

  private async getAccessibleFile(fileId: string): Promise<FileDocument> {
    if (!isValidObjectId(fileId)) {
      throw new NotFoundException(FILE_NOT_FOUND_MESSAGE);
    }

    const file = await this.filesModel.findOne({
      _id: fileId,
      status: { $ne: FileStatus.Deleted },
    }).exec();

    if (!file) {
      throw new NotFoundException(FILE_NOT_FOUND_MESSAGE);
    }

    return file;
  }

  private async assertSessionAccess(
    sessionId: string,
    user: AccessTokenPayload,
    requireActive: boolean,
  ): Promise<SessionDocument> {
    const email = user.email?.trim().toLowerCase();
    if (!email) {
      throw new ForbiddenException(SESSION_ACCESS_FORBIDDEN_MESSAGE);
    }

    if (user.sessionId && user.sessionId !== sessionId) {
      throw new ForbiddenException(SESSION_ACCESS_FORBIDDEN_MESSAGE);
    }

    const query: {
      sessionId: string;
      email: string;
      status: SessionStatus | { $ne: SessionStatus };
      expiresAt?: { $gt: Date };
    } = {
      sessionId,
      email,
      status: requireActive ? SessionStatus.Active : { $ne: SessionStatus.Deleted },
    };

    if (requireActive) {
      query.expiresAt = { $gt: new Date() };
    }

    const session = await this.sessionsModel.findOne(query).exec();
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }

    return session;
  }

  private buildS3Key(
    sessionId: string,
    category: FileCategory,
    fileId: string,
    originalName: string,
  ): string {
    const safeName = this.sanitizeFileName(originalName);
    const folder = category === FileCategory.Unfiled ? 'root' : category;
    return `sessions/${sessionId}/${folder}/${fileId}-${safeName}.pdf`;
  }

  private sanitizeFileName(originalName: string): string {
    const withoutPdfExt = originalName.replace(/\.pdf$/i, '');
    const sanitized = withoutPdfExt
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

    return sanitized || 'statement';
  }

  private normalizeOriginalFileName(originalName: string | undefined): string {
    const normalized = originalName?.trim();
    return normalized || 'statement.pdf';
  }

  private getFileNameKey(fileName: string): string {
    return fileName.trim().toLowerCase();
  }

  private resolveUploadCategory(statementType: StatementType, session: SessionDocument): FileCategory {
    const autoCategorizeOnUpload = session.autoCategorizeOnUpload !== false;
    if (!autoCategorizeOnUpload) {
      return FileCategory.Unfiled;
    }

    return CATEGORY_FROM_STATEMENT[statementType];
  }

  private normalizeFileCategory(category: FileCategory | undefined): FileCategory {
    if (!category) {
      return FileCategory.Unfiled;
    }

    if (
      category === FileCategory.Credit
      || category === FileCategory.Checking
      || category === FileCategory.Savings
      || category === FileCategory.Unknown
      || category === FileCategory.Unfiled
    ) {
      return category;
    }

    return FileCategory.Unfiled;
  }

  private getStatementTypeForMoveCategory(category: FileCategory): StatementType | null {
    switch (category) {
      case FileCategory.Credit:
        return StatementType.Credit;
      case FileCategory.Checking:
        return StatementType.Checking;
      case FileCategory.Savings:
        return StatementType.Savings;
      case FileCategory.Unknown:
        return StatementType.Unknown;
      case FileCategory.Unfiled:
        return null;
      default:
        return null;
    }
  }

  private buildStatementTypeByFileNameKey(
    statementTypeByName: Map<string, StatementType>,
  ): Map<string, StatementType> {
    const byFileNameKey = new Map<string, StatementType>();
    for (const [fileName, statementType] of statementTypeByName.entries()) {
      byFileNameKey.set(this.getFileNameKey(fileName), statementType);
    }

    return byFileNameKey;
  }

  private async getExistingFileNameKeys(sessionId: string): Promise<Set<string>> {
    const existingFiles = await this.filesModel.find({
      sessionId,
      status: { $ne: FileStatus.Deleted },
    })
      .select({ originalName: 1, _id: 0 })
      .lean<Array<{ originalName?: string }>>()
      .exec();

    const fileNameKeys = new Set<string>();
    for (const file of existingFiles) {
      if (!file?.originalName) {
        continue;
      }

      fileNameKeys.add(this.getFileNameKey(file.originalName));
    }

    return fileNameKeys;
  }

  private getRequiredEnv(name: string): string {
    const value = normalizeEnv(this.configService.get<string>(name));
    if (!value) {
      throw new InternalServerErrorException(`${name} must be configured.`);
    }

    return value;
  }

  private getMaxFilesPerUpload(): number {
    const parsed = Number.parseInt(this.configService.get<string>('MAX_FILES_PER_UPLOAD') ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }

  private getMaxFileSizeMb(): number {
    const parsed = Number.parseInt(this.configService.get<string>('MAX_FILE_SIZE_MB') ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_MAX_FILE_SIZE_MB;
  }

  private getMaxFileSizeBytes(): number {
    return this.getMaxFileSizeMb() * 1024 * 1024;
  }

  private getUploadFailureReason(error: unknown): string {
    const err = error as { name?: string; message?: string; code?: string };
    const name = (err?.name ?? '').toString();
    const code = (err?.code ?? '').toString();
    const message = (err?.message ?? '').toString();
    const combined = `${name} ${code} ${message}`.toLowerCase();

    if (combined.includes('nosuchbucket')) {
      return 'S3 bucket was not found. Verify S3_BUCKET_NAME.';
    }

    if (
      combined.includes('accessdenied')
      || combined.includes('invalidaccesskeyid')
      || combined.includes('signaturedoesnotmatch')
      || combined.includes('not authorized')
      || combined.includes('forbidden')
    ) {
      return 'S3 credentials are invalid or missing PutObject permission.';
    }

    if (
      combined.includes('authorizationheadermalformed')
      || combined.includes('permanentredirect')
      || combined.includes('wrong region')
    ) {
      return 'S3 region does not match the bucket region.';
    }

    if (
      combined.includes('timeout')
      || combined.includes('econnrefused')
      || combined.includes('enotfound')
      || combined.includes('network')
      || combined.includes('socket')
    ) {
      return 'Unable to reach S3 from the API runtime.';
    }

    return FILE_UPLOAD_FAILED_MESSAGE;
  }

  private async detectStatementTypeFromPdf(pdfBuffer: Buffer): Promise<DetectionResult> {
    const text = await this.extractPdfText(pdfBuffer);
    return this.detectStatementTypeFromText(text);
  }

  private async extractPdfText(pdfBuffer: Buffer): Promise<string> {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const result = await parser.getText();
      return (result.text ?? '').toLowerCase();
    } catch {
      return '';
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private detectStatementTypeFromText(text: string): DetectionResult {
    if (!text) {
      return {
        autoDetectedType: StatementType.Unknown,
        detectionConfidence: 0,
        isLikelyStatement: false,
      };
    }

    const entries = Object.entries(STATEMENT_KEYWORDS).map(([type, keywords]) => {
      const uniqueKeywordMatches = keywords.reduce(
        (acc, keyword) => (text.includes(keyword) ? acc + 1 : acc),
        0,
      );
      const mentionScore = keywords.reduce(
        (acc, keyword) => acc + this.countKeywordOccurrences(text, keyword),
        0,
      );
      return {
        type: type as Exclude<StatementType, StatementType.Unknown>,
        uniqueKeywordMatches,
        mentionScore,
        totalKeywords: keywords.length,
      };
    });

    const candidates = entries.filter((entry) => entry.uniqueKeywordMatches > 0 || entry.mentionScore > 0);
    if (candidates.length === 0) {
      return {
        autoDetectedType: StatementType.Unknown,
        detectionConfidence: 0,
        isLikelyStatement: false,
      };
    }

    candidates.sort((a, b) => {
      if (b.uniqueKeywordMatches !== a.uniqueKeywordMatches) {
        return b.uniqueKeywordMatches - a.uniqueKeywordMatches;
      }
      if (b.mentionScore !== a.mentionScore) {
        return b.mentionScore - a.mentionScore;
      }

      const aCoverage = a.totalKeywords > 0 ? a.uniqueKeywordMatches / a.totalKeywords : 0;
      const bCoverage = b.totalKeywords > 0 ? b.uniqueKeywordMatches / b.totalKeywords : 0;
      if (bCoverage !== aCoverage) {
        return bCoverage - aCoverage;
      }

      return STATEMENT_TYPE_PRIORITY[b.type] - STATEMENT_TYPE_PRIORITY[a.type];
    });

    const winner = candidates[0];
    const confidence = winner.totalKeywords > 0
      ? winner.uniqueKeywordMatches / winner.totalKeywords
      : 0;
    return {
      autoDetectedType: winner.type,
      detectionConfidence: Number(confidence.toFixed(2)),
      isLikelyStatement: true,
    };
  }

  private countKeywordOccurrences(text: string, keyword: string): number {
    let fromIndex = 0;
    let count = 0;

    while (fromIndex < text.length) {
      const index = text.indexOf(keyword, fromIndex);
      if (index === -1) {
        break;
      }

      count += 1;
      fromIndex = index + keyword.length;
    }

    return count;
  }
}
