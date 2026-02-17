import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
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
  s3Key: string;
  uploadedAt: string;
}

export interface RejectedFileItem {
  originalName: string;
  reason: string;
}

export interface UploadFilesResponse {
  uploaded: UploadedFileItem[];
  rejected: RejectedFileItem[];
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
}

export interface DeleteFileResponse {
  deleted: boolean;
  fileId: string;
}

@Injectable()
export class FilesService {
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
      const fileRecord = new this.filesModel({
        sessionId,
        originalName,
        mimeType: file.mimetype,
        size: file.size,
        statementType,
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
          s3Key: fileRecord.s3Key,
          uploadedAt: new Date(fileRecord.uploadedAt).toISOString(),
        });
      } catch {
        await this.filesModel.updateOne(
          { _id: fileId },
          { $set: { status: FileStatus.Rejected } },
        ).exec();

        rejected.push({
          originalName,
          reason: FILE_UPLOAD_FAILED_MESSAGE,
        });
      }
    }

    return { uploaded, rejected };
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
    await file.save();

    return {
      id: file._id.toString(),
      statementType: file.statementType,
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
    const value = this.configService.get<string>(name)?.trim();
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
}
