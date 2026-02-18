import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { sha256Hex } from '../../common/utils/hash.util';
import { getSanitizedApiPublicUrl, getSanitizedClientPublicUrl } from '../../config/public-url.config';
import { EmailToken, EmailTokenDocument, EmailTokenPurpose } from '../../db/schemas/email-token.schema';
import { EmailService } from '../email/email.service';
import { SessionSummary, SessionsService } from '../sessions/sessions.service';
import { RequestLinkDto } from './dto/request-link.dto';
import { RequestSessionsDto } from './dto/request-sessions.dto';
import { AuthRateLimiterService } from './rate-limiter.service';
import { generateMagicToken, MAGIC_TOKEN_BYTES } from './utils/magic-token';

const DEFAULT_MAGIC_LINK_TTL_MINUTES = 15;
const DEFAULT_JWT_EXPIRES_IN = '1h';
const REQUEST_LINK_MESSAGE = "If we found a session, you'll receive an email shortly.";
const REQUEST_SESSIONS_MESSAGE = "If we found sessions, you'll receive an email shortly.";
const INVALID_TOKEN_MESSAGE = 'Invalid or expired token.';
const INVALID_ACCESS_TOKEN_MESSAGE = 'Unable to determine access token expiration.';

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

export type AccessTokenType = 'continue_session' | 'find_sessions' | 'session_bootstrap';

export interface AccessTokenPayload {
  email: string;
  sessionId?: string;
  type: AccessTokenType;
}

export interface VerifyResponse {
  ok: true;
  accessToken: string;
  expiresIn: number;
  sessions: SessionSummary[];
}

export interface AuthEmailDebugResponse {
  emailProvider: string;
  hasResendKey: boolean;
  emailFrom: string;
  clientPublicUrl: string;
  apiPublicUrl: string;
  magicLinkTtlMinutes: number;
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
    private readonly jwtService: JwtService,
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

      await this.emailService.sendMagicLink(dto.email, rawToken);
    } catch (error) {
      this.logger.error(
        'Failed to issue continue-session magic link.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { message: REQUEST_LINK_MESSAGE };
  }

  async requestSessions(dto: RequestSessionsDto, context: RequestContext): Promise<GenericAuthResponse> {
    const normalizedEmail = this.normalizeEmail(dto.email);
    if (this.rateLimiter.isRateLimited('request-sessions', context.ip, normalizedEmail)) {
      this.logRequestSessionsDiagnostics({
        normalizedEmail,
        sessionsFoundCount: 0,
        willSendEmail: false,
      });
      return { message: REQUEST_SESSIONS_MESSAGE };
    }

    const sessionsFoundCount = await this.sessionsService.countActiveSessionsForEmail(normalizedEmail);
    const willSendEmail = sessionsFoundCount > 0;
    this.logRequestSessionsDiagnostics({
      normalizedEmail,
      sessionsFoundCount,
      willSendEmail,
    });

    if (!willSendEmail) {
      return { message: REQUEST_SESSIONS_MESSAGE };
    }

    try {
      const rawToken = await this.createEmailToken({
        email: normalizedEmail,
        purpose: EmailTokenPurpose.FindSessions,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await this.emailService.sendMagicLink(normalizedEmail, rawToken);
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
    const tokenHash = sha256Hex(rawToken);
    const tokenDoc = await this.emailTokensModel.findOneAndUpdate(
      {
        tokenHash,
        usedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { usedAt: now } },
      { new: true },
    ).exec();

    await this.logVerifyTokenDiagnostics(tokenHash, now, tokenDoc);

    if (!tokenDoc) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    const { accessToken, expiresIn } = this.createAccessToken(tokenDoc);
    const sessions = await this.getSessionsForToken(tokenDoc);
    return {
      ok: true,
      accessToken,
      expiresIn,
      sessions,
    };
  }

  isDebugEmailEndpointEnabled(): boolean {
    const nodeEnv = this.getSanitizedConfigValue('NODE_ENV')?.toLowerCase();
    return nodeEnv !== 'production' && nodeEnv !== 'prod';
  }

  getEmailDebugConfig(): AuthEmailDebugResponse {
    return {
      emailProvider: this.getSanitizedConfigValue('EMAIL_PROVIDER') ?? 'console',
      hasResendKey: Boolean(this.getSanitizedConfigValue('RESEND_API_KEY')),
      emailFrom: this.getSanitizedConfigValue('EMAIL_FROM') ?? 'onboarding@resend.dev',
      clientPublicUrl: getSanitizedClientPublicUrl(),
      apiPublicUrl: getSanitizedApiPublicUrl(),
      magicLinkTtlMinutes: this.getMagicLinkTtlMinutes(),
    };
  }

  private async createEmailToken(payload: EmailTokenPayload): Promise<string> {
    const now = new Date();
    const expiresAt = this.getMagicLinkExpiration(now);
    const normalizedEmail = this.normalizeEmail(payload.email);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const rawToken = generateMagicToken(MAGIC_TOKEN_BYTES);
      const tokenHash = sha256Hex(rawToken);

      try {
        await this.emailTokensModel.create({
          tokenHash,
          email: normalizedEmail,
          sessionId: payload.sessionId,
          purpose: payload.purpose,
          createdAt: now,
          usedAt: null,
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

  private getMagicLinkExpiration(now = new Date()): Date {
    const ttlMinutes = this.getMagicLinkTtlMinutes();
    return new Date(now.getTime() + ttlMinutes * 60 * 1000);
  }

  private getMagicLinkTtlMinutes(): number {
    const raw = this.getSanitizedConfigValue('MAGIC_LINK_TTL_MINUTES');
    if (!raw || !/^[1-9]\d*$/.test(raw)) {
      return DEFAULT_MAGIC_LINK_TTL_MINUTES;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }

    return DEFAULT_MAGIC_LINK_TTL_MINUTES;
  }

  private createAccessToken(tokenDoc: EmailTokenDocument): { accessToken: string; expiresIn: number } {
    const payload: AccessTokenPayload = {
      email: tokenDoc.email,
      type: this.getAccessTokenType(tokenDoc.purpose),
    };

    if (tokenDoc.purpose === EmailTokenPurpose.ContinueSession && tokenDoc.sessionId) {
      payload.sessionId = tokenDoc.sessionId;
    }

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.getJwtExpiresIn(),
    });

    return {
      accessToken,
      expiresIn: this.getExpiresInSeconds(accessToken),
    };
  }

  private getAccessTokenType(purpose: EmailTokenPurpose): AccessTokenType {
    if (purpose === EmailTokenPurpose.ContinueSession) {
      return 'continue_session';
    }

    return 'find_sessions';
  }

  private getJwtExpiresIn(): string {
    const raw = this.configService.get<string>('JWT_EXPIRES_IN')?.trim();
    if (raw) {
      return raw;
    }

    return DEFAULT_JWT_EXPIRES_IN;
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

    const fallback = this.parseExpiresInToSeconds(this.getJwtExpiresIn());
    if (fallback !== null) {
      return fallback;
    }

    throw new Error(INVALID_ACCESS_TOKEN_MESSAGE);
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

  private isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const mongoError = error as { code?: number };
    return mongoError.code === 11000;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private logRequestSessionsDiagnostics(input: {
    normalizedEmail: string;
    sessionsFoundCount: number;
    willSendEmail: boolean;
  }): void {
    if (!this.isDevLoggingEnabled()) {
      return;
    }

    const provider = this.getSanitizedConfigValue('EMAIL_PROVIDER') ?? 'console';
    const fromAddress = this.getSanitizedConfigValue('EMAIL_FROM') ?? 'onboarding@resend.dev';
    this.logger.debug(
      JSON.stringify({
        event: 'auth.request-sessions',
        normalizedEmail: input.normalizedEmail,
        sessionsFoundCount: input.sessionsFoundCount,
        willSendEmail: input.willSendEmail,
        emailProvider: provider,
        emailFrom: fromAddress,
      }),
    );
  }

  private async logVerifyTokenDiagnostics(
    tokenHash: string,
    now: Date,
    consumedTokenDoc: EmailTokenDocument | null,
  ): Promise<void> {
    if (!this.isDevLoggingEnabled()) {
      return;
    }

    let foundToken = Boolean(consumedTokenDoc);
    let isExpired = false;
    let isUsed = false;
    let purpose: EmailTokenPurpose | null = consumedTokenDoc?.purpose ?? null;

    if (!consumedTokenDoc) {
      const existingToken = await this.emailTokensModel.findOne({ tokenHash })
        .select({ expiresAt: 1, usedAt: 1, purpose: 1, _id: 0 })
        .lean<{ expiresAt?: Date | string; usedAt?: Date | string | null; purpose?: EmailTokenPurpose }>()
        .exec();

      if (existingToken) {
        foundToken = true;
        purpose = existingToken.purpose ?? null;

        const expiresAt = existingToken.expiresAt ? new Date(existingToken.expiresAt) : null;
        isExpired = Boolean(expiresAt) && expiresAt.getTime() <= now.getTime();
        isUsed = Boolean(existingToken.usedAt);
      }
    }

    this.logger.debug(
      JSON.stringify({
        event: 'auth.verify-token',
        tokenHashPrefix: tokenHash.slice(0, 8),
        foundToken,
        isExpired,
        isUsed,
        purpose,
      }),
    );
  }

  private isDevLoggingEnabled(): boolean {
    const nodeEnv = this.getSanitizedConfigValue('NODE_ENV')?.toLowerCase();
    return nodeEnv === 'development' || nodeEnv === 'dev' || nodeEnv === 'local';
  }

  private getSanitizedConfigValue(name: string): string | null {
    const raw = this.configService.get<string>(name);
    if (!raw) {
      return null;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
      const unquoted = trimmed.slice(1, -1).trim();
      return unquoted || null;
    }

    return trimmed;
  }
}
