import { ConfigService } from '@nestjs/config';
import { generateSessionId } from './utils/session-id';
import { SessionsService } from './sessions.service';

jest.mock('./utils/session-id', () => ({
  generateSessionId: jest.fn(),
}));

describe('SessionsService', () => {
  const mockedGenerateSessionId = generateSessionId as jest.MockedFunction<typeof generateSessionId>;

  let service: SessionsService;
  let sessionsModel: {
    exists: jest.Mock;
    create: jest.Mock;
  };

  beforeEach(() => {
    sessionsModel = {
      exists: jest.fn(),
      create: jest.fn(),
    };

    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    service = new SessionsService(sessionsModel as never, configService);
    mockedGenerateSessionId.mockReset();
  });

  it('retries when a generated session ID collides', async () => {
    const expiresAt = new Date('2026-03-01T00:00:00.000Z');

    mockedGenerateSessionId
      .mockReturnValueOnce('AAAAAAA2')
      .mockReturnValueOnce('BBBBBBB3');

    sessionsModel.exists
      .mockResolvedValueOnce({ _id: 'collision' })
      .mockResolvedValueOnce(null);

    sessionsModel.create.mockResolvedValue({
      sessionId: 'BBBBBBB3',
      email: 'user@example.com',
      expiresAt,
    });

    const result = await service.createSession({ email: 'user@example.com' });

    expect(sessionsModel.exists).toHaveBeenCalledTimes(2);
    expect(sessionsModel.exists).toHaveBeenNthCalledWith(1, { sessionId: 'AAAAAAA2' });
    expect(sessionsModel.exists).toHaveBeenNthCalledWith(2, { sessionId: 'BBBBBBB3' });
    expect(sessionsModel.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      sessionId: 'BBBBBBB3',
      email: 'user@example.com',
      expiresAt: expiresAt.toISOString(),
    });
  });
});
