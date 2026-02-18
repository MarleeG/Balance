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
import { FileDocument, FileRecord, FileStatus, StatementType } from '../../db/schemas/file.schema';
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

export interface SessionFileSummary {
  id: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  size: number;
  statementType: StatementType;
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

    await this.assertSessionAccess(sessionId, user, true);

    const maxFiles = this.getMaxFilesPerUpload();
    const maxFileSizeBytes = this.getMaxFileSizeBytes();
    const bucket = this.getRequiredEnv('S3_BUCKET_NAME');
    const metaMap = statementTypeByName ?? new Map<string, StatementType>();

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
      const originalName = file.originalname ?? 'statement.pdf';

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

      const statementType = metaMap.get(originalName) ?? StatementType.Unknown;
      // V1 requirement: run detection inline during the upload request (no queue/background worker).
      const detection = await this.detectStatementTypeFromPdf(file.buffer);
      const fileRecord = new this.filesModel({
        sessionId,
        originalName,
        mimeType: file.mimetype,
        size: file.size,
        statementType,
        autoDetectedType: detection.autoDetectedType,
        detectionConfidence: detection.detectionConfidence,
        isLikelyStatement: detection.isLikelyStatement,
        status: FileStatus.Pending,
        s3Bucket: bucket,
        s3Key: '',
      });

      const fileId = fileRecord._id.toString();
      fileRecord.s3Key = this.buildS3Key(sessionId, statementType, fileId, originalName);
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
    statementType: StatementType,
    fileId: string,
    originalName: string,
  ): string {
    const safeName = this.sanitizeFileName(originalName);
    return `sessions/${sessionId}/${statementType}/${fileId}-${safeName}.pdf`;
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
      const score = keywords.reduce((acc, keyword) => (text.includes(keyword) ? acc + 1 : acc), 0);
      return {
        type: type as Exclude<StatementType, StatementType.Unknown>,
        score,
        totalKeywords: keywords.length,
      };
    });

    const highestScore = Math.max(...entries.map((entry) => entry.score));
    const totalScore = entries.reduce((acc, entry) => acc + entry.score, 0);

    if (highestScore <= 0) {
      return {
        autoDetectedType: StatementType.Unknown,
        detectionConfidence: 0,
        isLikelyStatement: false,
      };
    }

    const winners = entries.filter((entry) => entry.score === highestScore);
    if (winners.length !== 1) {
      const confidence = totalScore > 0 ? highestScore / totalScore : 0;
      return {
        autoDetectedType: StatementType.Unknown,
        detectionConfidence: Number(confidence.toFixed(2)),
        isLikelyStatement: true,
      };
    }

    const winner = winners[0];
    const confidence = winner.totalKeywords > 0 ? winner.score / winner.totalKeywords : 0;
    return {
      autoDetectedType: winner.type,
      detectionConfidence: Number(confidence.toFixed(2)),
      isLikelyStatement: true,
    };
  }
}
