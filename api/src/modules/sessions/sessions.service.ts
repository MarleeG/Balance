import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FileDocument, FileRecord, FileStatus } from '../../db/schemas/file.schema';
import { Session, SessionDocument, SessionStatus } from '../../db/schemas/session.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { StorageService } from '../storage/storage.service';
import type { CreateSessionDto } from './dto/create-session.dto';
import { generateSessionId } from './utils/session-id';

const DEFAULT_SESSION_TTL_DAYS = 7;
const SESSION_ID_RETRY_LIMIT = 5;
const SESSION_ID_COLLISION_MESSAGE = 'Unable to create a unique session ID after 5 attempts.';
const SESSION_NOT_FOUND_MESSAGE = 'Session not found.';
const SESSION_ACCESS_FORBIDDEN_MESSAGE = 'Access to this session is not allowed.';
const DEFAULT_BOOTSTRAP_ACCESS_TOKEN_EXPIRES_IN = '1h';
const DEFAULT_BOOTSTRAP_ACCESS_TOKEN_EXPIRES_SECONDS = 60 * 60;

export interface CreateSessionResponse {
  sessionId: string;
  email: string;
  expiresAt: string;
  accessToken: string;
  expiresIn: number;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  status: SessionStatus;
  uploadedFileCount: number;
}

export interface DeleteSessionResponse {
  deleted: boolean;
}

interface ActiveSessionFilter {
  status: SessionStatus.Active;
  expiresAt: { $gt: Date };
  $or: Array<{ deletedAt: { $exists: false } } | { deletedAt: null }>;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @InjectModel(Session.name)
    private readonly sessionsModel: Model<SessionDocument>,
    @InjectModel(FileRecord.name)
    private readonly filesModel: Model<FileDocument>,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
    private readonly jwtService: JwtService,
  ) {}

  async createSession(dto: CreateSessionDto): Promise<CreateSessionResponse> {
    const now = new Date();
    const expiresAt = this.getSessionExpiration(now);

    for (let attempt = 1; attempt <= SESSION_ID_RETRY_LIMIT; attempt += 1) {
      const sessionId = generateSessionId();
      const existingSession = await this.sessionsModel.exists({ sessionId });

      if (existingSession) {
        continue;
      }

      try {
        const created = await this.sessionsModel.create({
          email: dto.email,
          sessionId,
          status: SessionStatus.Active,
          expiresAt,
          lastAccessedAt: now,
        });

        const { accessToken, expiresIn } = this.createSessionBootstrapAccessToken(created.email, created.sessionId);

        return {
          sessionId: created.sessionId,
          email: created.email,
          expiresAt: new Date(created.expiresAt).toISOString(),
          accessToken,
          expiresIn,
        };
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          continue;
        }

        this.logger.error(
          'Failed to create session record or bootstrap token.',
          error instanceof Error ? error.stack : String(error),
        );
        throw new HttpException('Failed to create session.', HttpStatus.INTERNAL_SERVER_ERROR, {
          cause: error,
        });
      }
    }

    throw new InternalServerErrorException(SESSION_ID_COLLISION_MESSAGE);
  }

  async findActiveSessionByIdAndEmail(sessionId: string, email: string): Promise<SessionSummary | null> {
    const normalizedEmail = this.normalizeEmail(email);
    const session = await this.sessionsModel.findOne({
      ...this.getActiveSessionFilter(),
      sessionId,
      email: normalizedEmail,
    }).exec();

    if (!session) {
      return null;
    }

    const uploadedFileCounts = await this.getUploadedFileCountsBySessionIds([session.sessionId]);
    return this.toSessionSummary(session, uploadedFileCounts.get(session.sessionId) ?? 0);
  }

  async hasActiveSessionsForEmail(email: string): Promise<boolean> {
    return (await this.countActiveSessionsForEmail(email)) > 0;
  }

  async countActiveSessionsForEmail(email: string): Promise<number> {
    const normalizedEmail = this.normalizeEmail(email);
    return this.sessionsModel.countDocuments({
      ...this.getActiveSessionFilter(),
      email: normalizedEmail,
    }).exec();
  }

  async listActiveSessionsForEmail(email: string): Promise<SessionSummary[]> {
    const normalizedEmail = this.normalizeEmail(email);
    const sessions = await this.sessionsModel.find({
      ...this.getActiveSessionFilter(),
      email: normalizedEmail,
    }).sort({ createdAt: -1 }).exec();

    const uploadedFileCounts = await this.getUploadedFileCountsBySessionIds(
      sessions.map((session) => session.sessionId),
    );

    return sessions.map((session) => this.toSessionSummary(session, uploadedFileCounts.get(session.sessionId) ?? 0));
  }

  async getActiveSessionById(sessionId: string, user: { email: string; sessionId?: string }): Promise<SessionSummary> {
    if (user.sessionId && user.sessionId !== sessionId) {
      throw new ForbiddenException(SESSION_ACCESS_FORBIDDEN_MESSAGE);
    }

    const session = await this.findActiveSessionByIdAndEmail(sessionId, user.email);
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }

    return session;
  }

  async deleteActiveSessionById(
    sessionId: string,
    user: { email: string; sessionId?: string },
  ): Promise<DeleteSessionResponse> {
    await this.getOwnedSessionById(sessionId, user);

    await this.sessionsModel.updateOne(
      {
        sessionId,
        email: user.email,
      },
      {
        $set: {
          status: SessionStatus.Deleted,
          deletedAt: new Date(),
        },
      },
    ).exec();

    const uploadedFiles = await this.filesModel.find({
      sessionId,
      status: FileStatus.Uploaded,
    }).exec();

    const deleteResults = await Promise.allSettled(
      uploadedFiles.map(async (file) => this.storageService.deleteObject(file.s3Bucket, file.s3Key)),
    );

    for (let i = 0; i < deleteResults.length; i += 1) {
      const result = deleteResults[i];
      if (result.status === 'fulfilled') {
        continue;
      }

      const fileId = uploadedFiles[i]?._id?.toString() ?? 'unknown';
      const details = result.reason instanceof Error ? result.reason.message : String(result.reason);
      this.logger.warn(`Failed to delete S3 object for file ${fileId}: ${details}`);
    }

    if (uploadedFiles.length > 0) {
      const deletedAt = new Date();
      await this.filesModel.updateMany(
        { _id: { $in: uploadedFiles.map((file) => file._id) } },
        { $set: { status: FileStatus.Deleted, deletedAt } },
      ).exec();
    }

    return { deleted: true };
  }

  private async getOwnedSessionById(
    sessionId: string,
    user: { email: string; sessionId?: string },
  ): Promise<SessionDocument> {
    if (user.sessionId && user.sessionId !== sessionId) {
      throw new ForbiddenException(SESSION_ACCESS_FORBIDDEN_MESSAGE);
    }

    const normalizedEmail = this.normalizeEmail(user.email);
    const session = await this.sessionsModel.findOne({
      sessionId,
      email: normalizedEmail,
      status: { $ne: SessionStatus.Deleted },
    }).exec();

    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }

    return session;
  }

  private getSessionExpiration(now: Date): Date {
    const ttlDays = this.getSessionTtlDays();
    return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  }

  private getSessionTtlDays(): number {
    const raw = this.configService.get<string>('SESSION_TTL_DAYS');
    const parsed = Number.parseInt(raw ?? '', 10);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_SESSION_TTL_DAYS;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const possibleMongoError = error as { code?: number };
    return possibleMongoError.code === 11000;
  }

  private getActiveSessionFilter(): ActiveSessionFilter {
    return {
      status: SessionStatus.Active,
      expiresAt: { $gt: new Date() },
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    };
  }

  private toSessionSummary(
    session: Pick<Session, 'sessionId' | 'createdAt' | 'expiresAt' | 'status'>,
    uploadedFileCount: number,
  ): SessionSummary {
    const createdAt = 'createdAt' in session && session.createdAt ? new Date(session.createdAt).toISOString() : '';

    return {
      sessionId: session.sessionId,
      createdAt,
      expiresAt: new Date(session.expiresAt).toISOString(),
      status: session.status,
      uploadedFileCount,
    };
  }

  private async getUploadedFileCountsBySessionIds(sessionIds: string[]): Promise<Map<string, number>> {
    const countsBySessionId = new Map<string, number>();
    if (sessionIds.length === 0) {
      return countsBySessionId;
    }

    const uniqueSessionIds = [...new Set(sessionIds)];
    const countRows = await this.filesModel.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          sessionId: { $in: uniqueSessionIds },
          status: FileStatus.Uploaded,
        },
      },
      {
        $group: {
          _id: '$sessionId',
          count: { $sum: 1 },
        },
      },
    ]).exec();

    for (const row of countRows) {
      if (typeof row._id === 'string' && Number.isFinite(row.count)) {
        countsBySessionId.set(row._id, row.count);
      }
    }

    return countsBySessionId;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private createSessionBootstrapAccessToken(
    email: string,
    sessionId: string,
  ): { accessToken: string; expiresIn: number } {
    const payload: AccessTokenPayload = {
      email,
      sessionId,
      type: 'session_bootstrap',
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.getBootstrapAccessTokenExpiresIn(),
    });

    return {
      accessToken,
      expiresIn: this.getExpiresInSeconds(accessToken),
    };
  }

  private getBootstrapAccessTokenExpiresIn(): string {
    const raw = this.getSanitizedEnvValue('JWT_EXPIRES_IN');
    if (!raw) {
      return DEFAULT_BOOTSTRAP_ACCESS_TOKEN_EXPIRES_IN;
    }

    const numericSeconds = Number.parseInt(raw, 10);
    if (Number.isInteger(numericSeconds) && numericSeconds > 0 && String(numericSeconds) === raw) {
      return String(numericSeconds);
    }

    const normalizedTimespan = raw.toLowerCase().replace(/\s+/g, '');
    if (/^\d+[smhd]$/.test(normalizedTimespan)) {
      return normalizedTimespan;
    }

    return DEFAULT_BOOTSTRAP_ACCESS_TOKEN_EXPIRES_IN;
  }

  private getExpiresInSeconds(accessToken: string): number {
    const decoded = this.jwtService.decode(accessToken);
    if (decoded && typeof decoded === 'object' && 'exp' in decoded && 'iat' in decoded) {
      const exp = Number((decoded as { exp?: number }).exp);
      const iat = Number((decoded as { iat?: number }).iat);

      if (Number.isFinite(exp) && Number.isFinite(iat) && exp > iat) {
        return exp - iat;
      }
    }

    const fallback = this.parseExpiresInToSeconds(this.getBootstrapAccessTokenExpiresIn());
    return fallback ?? DEFAULT_BOOTSTRAP_ACCESS_TOKEN_EXPIRES_SECONDS;
  }

  private parseExpiresInToSeconds(value: string): number | null {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const match = normalized.match(/^(\d+)([smhd]?)$/);
    if (!match) {
      return null;
    }

    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    switch (match[2]) {
      case '':
      case 's':
        return amount;
      case 'm':
        return amount * 60;
      case 'h':
        return amount * 60 * 60;
      case 'd':
        return amount * 24 * 60 * 60;
      default:
        return null;
    }
  }

  private getSanitizedEnvValue(name: string): string | null {
    const value = this.configService.get<string>(name);
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      const unquoted = trimmed.slice(1, -1).trim();
      return unquoted || null;
    }

    return trimmed;
  }
}
