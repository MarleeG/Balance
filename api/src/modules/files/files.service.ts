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
  AccountType,
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
const DEFAULT_MAX_FILE_SIZE_MB = 25;
const MAX_DISPLAY_NAME_LENGTH = 80;
const ALLOWED_MIME_TYPE = 'application/pdf';
const FILE_UPLOAD_FAILED_MESSAGE = 'Failed to upload file to storage.';
const SESSION_NOT_FOUND_MESSAGE = 'Session not found.';
const FILE_NOT_FOUND_MESSAGE = 'File not found.';
const SESSION_ACCESS_FORBIDDEN_MESSAGE = 'Access to this session is not allowed.';
const DUPLICATE_FILE_NAME_REASON = 'A file with this name already exists in this session.';
const POSSIBLE_DUPLICATE_WARNING_PREFIX = 'Possible duplicate: this original filename matches an existing file renamed to';
const FILE_NAME_EMPTY_MESSAGE = 'File name cannot be empty.';
const FILE_EXTENSION_CHANGE_NOT_ALLOWED_MESSAGE = 'File extension cannot be changed.';
const DISPLAY_NAME_EMPTY_MESSAGE = 'Display name cannot be empty.';
const DISPLAY_NAME_TOO_LONG_MESSAGE = `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
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
  displayName: string;
  accountType?: AccountType;
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
  displayName: string;
  mimeType: string;
  size: number;
  accountType?: AccountType;
  statementType: StatementType;
  category: FileCategory;
  status: FileStatus;
  s3Bucket: string;
  s3Key: string;
  uploadedAt: string;
}

export interface UpdateFileResponse {
  id: string;
  originalName: string;
  displayName: string;
  accountType?: AccountType;
  statementType: StatementType;
  category: FileCategory;
  confirmedByUser: boolean;
}

export interface UpdateFileParams {
  statementType?: StatementType;
  originalName?: string;
  displayName?: string;
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
  private pdfParsePolyfillsInitialized = false;

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
    const filesByFileNameKey = await this.getExistingFilesByFileNameKey(sessionId);
    const fileNameKeysInSession = new Set(filesByFileNameKey.keys());

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
      let displayName: string;
      try {
        displayName = this.normalizeDisplayName(originalName);
      } catch (error) {
        rejected.push({
          originalName,
          reason: this.getDisplayNameValidationReason(error),
        });
        continue;
      }
      const fileNameKey = this.getFileNameKey(originalName);

      if (fileNameKeysInSession.has(fileNameKey)) {
        const matchingFiles = filesByFileNameKey.get(fileNameKey) ?? [];
        const renamedMatch = matchingFiles.find((existingFile) => {
          const existingDisplayName = this.resolveDisplayName(existingFile.displayName, existingFile.originalName);
          return this.getFileNameKey(existingDisplayName) !== fileNameKey;
        });

        if (!renamedMatch) {
          rejected.push({
            originalName,
            reason: DUPLICATE_FILE_NAME_REASON,
          });
          continue;
        }

        const renamedDisplayName = this.resolveDisplayName(renamedMatch.displayName, renamedMatch.originalName);
        warnings.push({
          originalName,
          reason: `${POSSIBLE_DUPLICATE_WARNING_PREFIX} "${renamedDisplayName}".`,
        });
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
      const accountType = this.getAccountTypeFromStatementType(statementType);
      fileNameKeysInSession.add(fileNameKey);
      const currentEntries = filesByFileNameKey.get(fileNameKey) ?? [];
      currentEntries.push({ originalName, displayName });
      filesByFileNameKey.set(fileNameKey, currentEntries);
      const fileRecord = new this.filesModel({
        sessionId,
        originalName,
        displayName,
        mimeType: file.mimetype,
        byteSize: file.size,
        accountType,
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
      fileRecord.s3Key = this.buildS3Key(sessionId, statementType, fileId);
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

        const accountType = this.resolveAccountType(fileRecord.accountType, fileRecord.statementType);
        uploaded.push({
          id: fileId,
          originalName: fileRecord.originalName,
          displayName: this.resolveDisplayName(fileRecord.displayName, fileRecord.originalName),
          ...(accountType ? { accountType } : {}),
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

    return files.map((file) => {
      const accountType = this.resolveAccountType(file.accountType, file.statementType);
      return {
        id: file._id.toString(),
        sessionId: file.sessionId,
        originalName: file.originalName,
        displayName: this.resolveDisplayName(file.displayName, file.originalName),
        mimeType: file.mimeType,
        size: this.resolveByteSize(file),
        ...(accountType ? { accountType } : {}),
        statementType: file.statementType,
        category: this.normalizeFileCategory(file.category),
        status: file.status,
        s3Bucket: file.s3Bucket,
        s3Key: file.s3Key,
        uploadedAt: new Date(file.uploadedAt).toISOString(),
      };
    });
  }

  async updateFile(
    fileId: string,
    updates: UpdateFileParams,
    user: AccessTokenPayload,
  ): Promise<UpdateFileResponse> {
    const file = await this.getAccessibleFile(fileId);
    await this.assertSessionAccess(file.sessionId, user, false);

    if (updates.statementType === undefined && updates.originalName === undefined && updates.displayName === undefined) {
      throw new BadRequestException('At least one updatable field must be provided.');
    }

    if (updates.statementType !== undefined) {
      file.statementType = updates.statementType;
      file.accountType = this.getAccountTypeFromStatementType(updates.statementType);
      if (this.normalizeFileCategory(file.category) !== FileCategory.Unfiled) {
        file.category = CATEGORY_FROM_STATEMENT[updates.statementType];
      }
    }

    if (updates.originalName !== undefined) {
      const nextName = this.normalizeEditableFileName(updates.originalName);
      this.assertFileExtensionUnchanged(file.originalName, nextName);
      if (this.getFileNameKey(nextName) !== this.getFileNameKey(file.originalName)) {
        await this.assertUniqueFileNameInSession(nextName, file.sessionId, file._id.toString());
      }
      file.originalName = nextName;
    }

    if (updates.displayName !== undefined) {
      file.displayName = this.normalizeDisplayName(updates.displayName);
    }

    file.confirmedByUser = true;
    this.ensureByteSize(file);
    await file.save();

    const accountType = this.resolveAccountType(file.accountType, file.statementType);
    return {
      id: file._id.toString(),
      originalName: file.originalName,
      displayName: this.resolveDisplayName(file.displayName, file.originalName),
      ...(accountType ? { accountType } : {}),
      statementType: file.statementType,
      category: this.normalizeFileCategory(file.category),
      confirmedByUser: file.confirmedByUser,
    };
  }

  async deleteFile(fileId: string, user: AccessTokenPayload): Promise<DeleteFileResponse> {
    const file = await this.getAccessibleFile(fileId);
    await this.assertSessionAccess(file.sessionId, user, false);

    await this.storageService.deleteObject(file.s3Bucket, file.s3Key);

    file.status = FileStatus.Deleted;
    file.deletedAt = new Date();
    this.ensureByteSize(file);
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
      accountType?: AccountType;
    } = {
      category,
      confirmedByUser: true,
    };

    if (targetStatementType) {
      updateSet.statementType = targetStatementType;
      updateSet.accountType = this.getAccountTypeFromStatementType(targetStatementType);
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
    accountType: StatementType,
    fileId: string,
  ): string {
    return `${sessionId}/${accountType}/${fileId}.pdf`;
  }

  private normalizeOriginalFileName(originalName: string | undefined): string {
    const normalized = originalName?.trim();
    return normalized || 'statement.pdf';
  }

  private getAccountTypeFromStatementType(statementType: StatementType): AccountType | undefined {
    switch (statementType) {
      case StatementType.Credit:
        return AccountType.Credit;
      case StatementType.Checking:
        return AccountType.Checking;
      case StatementType.Savings:
        return AccountType.Savings;
      case StatementType.Unknown:
      default:
        return undefined;
    }
  }

  private resolveAccountType(accountType: AccountType | undefined, statementType: StatementType): AccountType | undefined {
    if (
      accountType === AccountType.Credit
      || accountType === AccountType.Checking
      || accountType === AccountType.Savings
    ) {
      return accountType;
    }

    return this.getAccountTypeFromStatementType(statementType);
  }

  private resolveByteSize(file: Pick<FileDocument, 'byteSize' | 'size'>): number {
    if (typeof file.byteSize === 'number' && file.byteSize > 0) {
      return file.byteSize;
    }

    if (typeof file.size === 'number' && file.size > 0) {
      return file.size;
    }

    return 0;
  }

  private ensureByteSize(file: FileDocument): void {
    if (typeof file.byteSize === 'number' && file.byteSize > 0) {
      return;
    }

    if (typeof file.size === 'number' && file.size > 0) {
      file.byteSize = file.size;
    }
  }

  private normalizeEditableFileName(originalName: string): string {
    const normalized = originalName?.trim();
    if (!normalized) {
      throw new BadRequestException(FILE_NAME_EMPTY_MESSAGE);
    }

    return normalized;
  }

  private normalizeDisplayName(displayName: string): string {
    const normalized = displayName
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^A-Za-z0-9 ._()\-]/g, '-');

    if (!normalized) {
      throw new BadRequestException(DISPLAY_NAME_EMPTY_MESSAGE);
    }

    if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new BadRequestException(DISPLAY_NAME_TOO_LONG_MESSAGE);
    }

    return normalized;
  }

  private getDisplayNameValidationReason(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return response;
      }

      if (response && typeof response === 'object' && 'message' in response) {
        const message = (response as { message?: string | string[] }).message;
        if (typeof message === 'string' && message.length > 0) {
          return message;
        }
        if (Array.isArray(message) && typeof message[0] === 'string' && message[0].length > 0) {
          return message[0];
        }
      }

      if (error.message) {
        return error.message;
      }
    }

    return 'Invalid display name.';
  }

  private resolveDisplayName(displayName: string | undefined, originalName: string): string {
    const candidate = displayName && displayName.trim().length > 0
      ? displayName
      : originalName;
    return this.normalizeDisplayNameFallback(candidate);
  }

  private normalizeDisplayNameFallback(value: string): string {
    const normalized = value
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^A-Za-z0-9 ._()\-]/g, '-')
      .slice(0, MAX_DISPLAY_NAME_LENGTH);

    return normalized || 'statement';
  }

  private assertFileExtensionUnchanged(currentName: string, nextName: string): void {
    const currentExtension = this.getFileExtension(currentName);
    const nextExtension = this.getFileExtension(nextName);
    if (currentExtension !== nextExtension) {
      throw new BadRequestException(FILE_EXTENSION_CHANGE_NOT_ALLOWED_MESSAGE);
    }
  }

  private async assertUniqueFileNameInSession(
    originalName: string,
    sessionId: string,
    excludedFileId: string,
  ): Promise<void> {
    const escapedName = this.escapeRegex(originalName);
    const duplicate = await this.filesModel.exists({
      sessionId,
      status: { $ne: FileStatus.Deleted },
      _id: { $ne: excludedFileId },
      originalName: { $regex: `^${escapedName}$`, $options: 'i' },
    });

    if (duplicate) {
      throw new BadRequestException(DUPLICATE_FILE_NAME_REASON);
    }
  }

  private getFileNameKey(fileName: string): string {
    return fileName.trim().toLowerCase();
  }

  private getFileExtension(fileName: string): string {
    const normalized = fileName.trim();
    const lastDot = normalized.lastIndexOf('.');
    if (lastDot <= 0) {
      return '';
    }

    return normalized.slice(lastDot).toLowerCase();
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  private async getExistingFilesByFileNameKey(
    sessionId: string,
  ): Promise<Map<string, Array<{ originalName: string; displayName?: string }>>> {
    const existingFiles = await this.filesModel.find({
      sessionId,
      status: { $ne: FileStatus.Deleted },
    })
      .select({ originalName: 1, displayName: 1, _id: 0 })
      .lean<Array<{ originalName?: string; displayName?: string }>>()
      .exec();

    const filesByNameKey = new Map<string, Array<{ originalName: string; displayName?: string }>>();
    for (const file of existingFiles) {
      if (!file?.originalName) {
        continue;
      }

      const nameKey = this.getFileNameKey(file.originalName);
      const records = filesByNameKey.get(nameKey) ?? [];
      records.push({ originalName: file.originalName, displayName: file.displayName });
      filesByNameKey.set(nameKey, records);
    }

    return filesByNameKey;
  }

  private getRequiredEnv(name: string): string {
    const value = normalizeEnv(this.configService.get<string>(name));
    if (!value) {
      throw new InternalServerErrorException(`${name} must be configured.`);
    }

    return value;
  }

  private getMaxFilesPerUpload(): number {
    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }

  private getMaxFileSizeMb(): number {
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
    await this.ensurePdfParseRuntimePolyfills();

    let PDFParse: typeof import('pdf-parse').PDFParse;
    try {
      ({ PDFParse } = await import('pdf-parse'));
    } catch {
      return '';
    }

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

  private async ensurePdfParseRuntimePolyfills(): Promise<void> {
    if (this.pdfParsePolyfillsInitialized) {
      return;
    }

    this.pdfParsePolyfillsInitialized = true;
    const runtime = globalThis as Record<string, unknown>;
    if (runtime.DOMMatrix && runtime.ImageData && runtime.Path2D) {
      return;
    }

    try {
      // pdf-parse/pdfjs expects these globals in some Node runtimes.
      // @napi-rs/canvas is a transitive dependency of pdf-parse.
      const canvas = require('@napi-rs/canvas') as {
        DOMMatrix?: unknown;
        ImageData?: unknown;
        Path2D?: unknown;
      };
      if (!runtime.DOMMatrix && canvas.DOMMatrix) {
        runtime.DOMMatrix = canvas.DOMMatrix;
      }
      if (!runtime.ImageData && canvas.ImageData) {
        runtime.ImageData = canvas.ImageData;
      }
      if (!runtime.Path2D && canvas.Path2D) {
        runtime.Path2D = canvas.Path2D;
      }
    } catch {
      // Keep best-effort behavior; detection falls back to unknown.
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
