import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Session, SessionDocument, SessionStatus } from '../../db/schemas/session.schema';
import type { CreateSessionDto } from './dto/create-session.dto';
import { generateSessionId } from './utils/session-id';

const DEFAULT_SESSION_TTL_DAYS = 7;
const SESSION_ID_RETRY_LIMIT = 5;
const SESSION_ID_COLLISION_MESSAGE = 'Unable to create a unique session ID after 5 attempts.';

export interface CreateSessionResponse {
  sessionId: string;
  email: string;
  expiresAt: string;
}

export interface SessionSummary {
  sessionId: string;
  expiresAt: string;
  status: SessionStatus;
}

@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name)
    private readonly sessionsModel: Model<SessionDocument>,
    private readonly configService: ConfigService,
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

        return {
          sessionId: created.sessionId,
          email: created.email,
          expiresAt: new Date(created.expiresAt).toISOString(),
        };
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          continue;
        }

        throw new HttpException('Failed to create session.', HttpStatus.INTERNAL_SERVER_ERROR, {
          cause: error,
        });
      }
    }

    throw new InternalServerErrorException(SESSION_ID_COLLISION_MESSAGE);
  }

  async findActiveSessionByIdAndEmail(sessionId: string, email: string): Promise<SessionSummary | null> {
    const session = await this.sessionsModel.findOne({
      ...this.getActiveSessionFilter(),
      sessionId,
      email,
    }).exec();

    if (!session) {
      return null;
    }

    return this.toSessionSummary(session);
  }

  async hasActiveSessionsForEmail(email: string): Promise<boolean> {
    const existing = await this.sessionsModel.exists({
      ...this.getActiveSessionFilter(),
      email,
    });

    return Boolean(existing);
  }

  async listActiveSessionsForEmail(email: string): Promise<SessionSummary[]> {
    const sessions = await this.sessionsModel.find({
      ...this.getActiveSessionFilter(),
      email,
    }).sort({ createdAt: -1 }).exec();

    return sessions.map((session) => this.toSessionSummary(session));
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

  private getActiveSessionFilter(): { status: SessionStatus; expiresAt: { $gt: Date } } {
    return {
      status: SessionStatus.Active,
      expiresAt: { $gt: new Date() },
    };
  }

  private toSessionSummary(session: Pick<Session, 'sessionId' | 'expiresAt' | 'status'>): SessionSummary {
    return {
      sessionId: session.sessionId,
      expiresAt: new Date(session.expiresAt).toISOString(),
      status: session.status,
    };
  }
}
