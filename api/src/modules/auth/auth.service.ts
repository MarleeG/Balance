import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailToken, EmailTokenDocument, EmailTokenPurpose } from '../../db/schemas/email-token.schema';
import { EmailService } from '../email/email.service';
import { SessionSummary, SessionsService } from '../sessions/sessions.service';
import { RequestLinkDto } from './dto/request-link.dto';
import { RequestSessionsDto } from './dto/request-sessions.dto';
import { AuthRateLimiterService } from './rate-limiter.service';
import { generateMagicToken, hashMagicToken } from './utils/magic-token';

const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const REQUEST_LINK_MESSAGE = "If we found a session, you'll receive an email shortly.";
const REQUEST_SESSIONS_MESSAGE = "If we found sessions, you'll receive an email shortly.";
const INVALID_TOKEN_MESSAGE = 'Invalid or expired token.';

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

interface EmailTokenPayload {
  email: string;
  purpose: EmailTokenPurpose;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
}

export interface GenericAuthResponse {
  message: string;
}

export interface VerifyResponse {
  email: string;
  sessions: SessionSummary[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(EmailToken.name)
    private readonly emailTokensModel: Model<EmailTokenDocument>,
    private readonly sessionsService: SessionsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly rateLimiter: AuthRateLimiterService,
  ) {}

  async requestLink(dto: RequestLinkDto, context: RequestContext): Promise<GenericAuthResponse> {
    if (this.rateLimiter.isRateLimited('request-link', context.ip, dto.email)) {
      return { message: REQUEST_LINK_MESSAGE };
    }

    const session = await this.sessionsService.findActiveSessionByIdAndEmail(dto.sessionId, dto.email);
    if (!session) {
      return { message: REQUEST_LINK_MESSAGE };
    }

    try {
      const rawToken = await this.createEmailToken({
        email: dto.email,
        sessionId: dto.sessionId,
        purpose: EmailTokenPurpose.ContinueSession,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await this.emailService.sendMagicLink(dto.email, this.getMagicLinkUrl(rawToken));
    } catch (error) {
      this.logger.error(
        'Failed to issue continue-session magic link.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { message: REQUEST_LINK_MESSAGE };
  }

  async requestSessions(dto: RequestSessionsDto, context: RequestContext): Promise<GenericAuthResponse> {
    if (this.rateLimiter.isRateLimited('request-sessions', context.ip, dto.email)) {
      return { message: REQUEST_SESSIONS_MESSAGE };
    }

    const hasSessions = await this.sessionsService.hasActiveSessionsForEmail(dto.email);
    if (!hasSessions) {
      return { message: REQUEST_SESSIONS_MESSAGE };
    }

    try {
      const rawToken = await this.createEmailToken({
        email: dto.email,
        purpose: EmailTokenPurpose.FindSessions,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await this.emailService.sendMagicLink(dto.email, this.getMagicLinkUrl(rawToken));
    } catch (error) {
      this.logger.error(
        'Failed to issue find-sessions magic link.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { message: REQUEST_SESSIONS_MESSAGE };
  }

  async verifyToken(rawToken: string): Promise<VerifyResponse> {
    const now = new Date();
    const tokenHash = hashMagicToken(rawToken);
    const tokenDoc = await this.emailTokensModel.findOneAndUpdate(
      {
        tokenHash,
        expiresAt: { $gt: now },
        $or: [{ usedAt: { $exists: false } }, { usedAt: null }],
      },
      { $set: { usedAt: now } },
      { new: true },
    ).exec();

    if (!tokenDoc) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    const sessions = await this.getSessionsForToken(tokenDoc);
    return {
      email: tokenDoc.email,
      sessions,
    };
  }

  private async createEmailToken(payload: EmailTokenPayload): Promise<string> {
    const expiresAt = this.getMagicLinkExpiration();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const rawToken = generateMagicToken();
      const tokenHash = hashMagicToken(rawToken);

      try {
        await this.emailTokensModel.create({
          tokenHash,
          email: payload.email,
          sessionId: payload.sessionId,
          purpose: payload.purpose,
          expiresAt,
          ip: payload.ip,
          userAgent: payload.userAgent,
        });

        return rawToken;
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unable to generate a unique magic token hash.');
  }

  private async getSessionsForToken(tokenDoc: EmailTokenDocument): Promise<SessionSummary[]> {
    if (tokenDoc.purpose === EmailTokenPurpose.ContinueSession && tokenDoc.sessionId) {
      const session = await this.sessionsService.findActiveSessionByIdAndEmail(tokenDoc.sessionId, tokenDoc.email);
      return session ? [session] : [];
    }

    return this.sessionsService.listActiveSessionsForEmail(tokenDoc.email);
  }

  private getMagicLinkExpiration(): Date {
    const ttlMinutes = this.getMagicLinkTtlMinutes();
    return new Date(Date.now() + ttlMinutes * 60 * 1000);
  }

  private getMagicLinkTtlMinutes(): number {
    const raw = this.configService.get<string>('MAGIC_LINK_TTL_MINUTES');
    const parsed = Number.parseInt(raw ?? '', 10);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_MAGIC_LINK_TTL_MINUTES;
  }

  private getMagicLinkUrl(rawToken: string): string {
    const baseUrl = (this.configService.get<string>('APP_PUBLIC_URL') ?? 'http://localhost:5173').trim();
    return `${baseUrl}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const mongoError = error as { code?: number };
    return mongoError.code === 11000;
  }
}
