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
    findOne: jest.Mock;
  };
  let sessionsService: {
    findActiveSessionByIdAndEmail: jest.Mock;
    countActiveSessionsForEmail: jest.Mock;
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
  let configValues: Record<string, string | undefined>;

  beforeEach(() => {
    emailTokensModel = {
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }),
    };

    sessionsService = {
      findActiveSessionByIdAndEmail: jest.fn(),
      countActiveSessionsForEmail: jest.fn(),
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

    configValues = {
      APP_PUBLIC_URL: 'http://localhost:5173',
      MAGIC_LINK_TTL_MINUTES: '15',
      JWT_EXPIRES_IN: '1h',
    };

    const configService = {
      get: jest.fn((key: string) => configValues[key]),
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

  it('sends email for request-sessions when active sessions exist', async () => {
    sessionsService.countActiveSessionsForEmail.mockResolvedValue(2);
    emailTokensModel.create.mockResolvedValue({});

    const result = await service.requestSessions(
      { email: ' User@Example.com ' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(result).toEqual({
      message: "If we found sessions, you'll receive an email shortly.",
    });
    expect(sessionsService.countActiveSessionsForEmail).toHaveBeenCalledWith('user@example.com');
    expect(emailTokensModel.create).toHaveBeenCalledTimes(1);

    const createInput = emailTokensModel.create.mock.calls[0][0];
    expect(createInput).toEqual(expect.objectContaining({
      email: 'user@example.com',
      purpose: EmailTokenPurpose.FindSessions,
      tokenHash: expect.any(String),
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
      usedAt: null,
      ip: '127.0.0.1',
      userAgent: 'jest',
    }));
    expect(createInput.tokenHash).toHaveLength(64);

    expect(emailService.sendMagicLink).toHaveBeenCalledTimes(1);
    expect(emailService.sendMagicLink).toHaveBeenCalledWith(
      'user@example.com',
      expect.any(String),
    );
  });

  it('does not send email for request-sessions when no active sessions exist', async () => {
    sessionsService.countActiveSessionsForEmail.mockResolvedValue(0);

    const result = await service.requestSessions(
      { email: 'user@example.com' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(result).toEqual({
      message: "If we found sessions, you'll receive an email shortly.",
    });
    expect(sessionsService.countActiveSessionsForEmail).toHaveBeenCalledWith('user@example.com');
    expect(emailTokensModel.create).not.toHaveBeenCalled();
    expect(emailService.sendMagicLink).not.toHaveBeenCalled();
  });

  it('uses MAGIC_LINK_TTL_MINUTES as integer minutes when creating email tokens', async () => {
    configValues.MAGIC_LINK_TTL_MINUTES = '"30"';
    sessionsService.countActiveSessionsForEmail.mockResolvedValue(1);
    emailTokensModel.create.mockResolvedValue({});

    await service.requestSessions(
      { email: 'user@example.com' },
      { ip: '127.0.0.1', userAgent: 'jest' },
    );

    expect(emailTokensModel.create).toHaveBeenCalledTimes(1);
    const createInput = emailTokensModel.create.mock.calls[0][0] as {
      createdAt: Date;
      expiresAt: Date;
    };

    expect(createInput.createdAt).toBeInstanceOf(Date);
    expect(createInput.expiresAt).toBeInstanceOf(Date);
    expect(createInput.expiresAt.getTime() - createInput.createdAt.getTime()).toBe(30 * 60 * 1000);
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
      ok: true,
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
    expect(firstCallFilter.usedAt).toBeNull();
    expect(firstCallFilter.expiresAt).toEqual(expect.objectContaining({ $gt: expect.any(Date) }));
    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        email: 'user@example.com',
        type: 'find_sessions',
      },
      { expiresIn: '1h' },
    );

    await expect(service.verifyToken(rawToken)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizes quoted JWT_EXPIRES_IN when verifying token', async () => {
    configValues.JWT_EXPIRES_IN = '"1h"';
    const rawToken = 'quoted-exp-token';

    emailTokensModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        email: 'user@example.com',
        purpose: EmailTokenPurpose.FindSessions,
        sessionId: undefined,
      }),
    });
    sessionsService.listActiveSessionsForEmail.mockResolvedValue([]);

    await service.verifyToken(rawToken);

    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        email: 'user@example.com',
        type: 'find_sessions',
      },
      { expiresIn: '1h' },
    );
  });
});
