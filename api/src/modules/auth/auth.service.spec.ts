import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailTokenPurpose } from '../../db/schemas/email-token.schema';
import { EmailService } from '../email/email.service';
import { SessionStatus } from '../../db/schemas/session.schema';
import { SessionsService } from '../sessions/sessions.service';
import { AuthRateLimiterService } from './rate-limiter.service';
import { AuthService } from './auth.service';
import { hashMagicToken } from './utils/magic-token';

describe('AuthService', () => {
  let service: AuthService;
  let emailTokensModel: {
    create: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let sessionsService: {
    findActiveSessionByIdAndEmail: jest.Mock;
    hasActiveSessionsForEmail: jest.Mock;
    listActiveSessionsForEmail: jest.Mock;
  };
  let emailService: {
    sendMagicLink: jest.Mock;
  };
  let rateLimiter: {
    isRateLimited: jest.Mock;
  };
  let jwtService: {
    sign: jest.Mock;
    decode: jest.Mock;
  };

  beforeEach(() => {
    emailTokensModel = {
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    sessionsService = {
      findActiveSessionByIdAndEmail: jest.fn(),
      hasActiveSessionsForEmail: jest.fn(),
      listActiveSessionsForEmail: jest.fn(),
    };

    emailService = {
      sendMagicLink: jest.fn(),
    };

    rateLimiter = {
      isRateLimited: jest.fn().mockReturnValue(false),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('signed-jwt-token'),
      decode: jest.fn().mockReturnValue({
        iat: 1_700_000_000,
        exp: 1_700_003_600,
      }),
    };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'APP_PUBLIC_URL') {
          return 'http://localhost:5173';
        }

        if (key === 'MAGIC_LINK_TTL_MINUTES') {
          return '15';
        }

        if (key === 'JWT_EXPIRES_IN') {
          return '1h';
        }

        return undefined;
      }),
    } as unknown as ConfigService;

    service = new AuthService(
      emailTokensModel as never,
      sessionsService as unknown as SessionsService,
      emailService as unknown as EmailService,
      configService,
      rateLimiter as unknown as AuthRateLimiterService,
      jwtService as never,
    );
  });

  it('does not send email for request-link when session is not found', async () => {
    sessionsService.findActiveSessionByIdAndEmail.mockResolvedValue(null);

    const result = await service.requestLink(
      { email: 'user@example.com', sessionId: 'A1B2C3D4' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(result).toEqual({
      message: "If we found a session, you'll receive an email shortly.",
    });
    expect(emailTokensModel.create).not.toHaveBeenCalled();
    expect(emailService.sendMagicLink).not.toHaveBeenCalled();
  });

  it('marks token as used and rejects reuse', async () => {
    const rawToken = 'raw-token-value';
    const hashed = hashMagicToken(rawToken);
    const firstTokenDoc = {
      email: 'user@example.com',
      purpose: EmailTokenPurpose.FindSessions,
      sessionId: undefined,
    };

    emailTokensModel.findOneAndUpdate
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(firstTokenDoc),
      })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(null),
      });

    sessionsService.listActiveSessionsForEmail.mockResolvedValue([
      {
        sessionId: 'A2B3C4D5',
        expiresAt: '2026-03-01T00:00:00.000Z',
        status: SessionStatus.Active,
      },
    ]);

    const first = await service.verifyToken(rawToken);
    expect(first).toEqual({
      accessToken: 'signed-jwt-token',
      expiresIn: 3600,
      sessions: [
        {
          sessionId: 'A2B3C4D5',
          expiresAt: '2026-03-01T00:00:00.000Z',
          status: SessionStatus.Active,
        },
      ],
    });

    const firstCallFilter = emailTokensModel.findOneAndUpdate.mock.calls[0][0];
    expect(firstCallFilter.tokenHash).toBe(hashed);
    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        email: 'user@example.com',
        type: 'find_sessions',
      },
      { expiresIn: '1h' },
    );

    await expect(service.verifyToken(rawToken)).rejects.toBeInstanceOf(BadRequestException);
  });
});
