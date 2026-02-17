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
}
