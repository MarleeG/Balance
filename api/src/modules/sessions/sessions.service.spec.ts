import { ConfigService } from '@nestjs/config';
import { FileStatus } from '../../db/schemas/file.schema';
import { SessionStatus } from '../../db/schemas/session.schema';
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
    find: jest.Mock;
    findOne: jest.Mock;
    updateOne: jest.Mock;
  };
  let filesModel: {
    aggregate: jest.Mock;
    find: jest.Mock;
    updateMany: jest.Mock;
  };
  let storageService: {
    deleteObject: jest.Mock;
  };
  let jwtService: {
    sign: jest.Mock;
    decode: jest.Mock;
  };

  beforeEach(() => {
    sessionsModel = {
      exists: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    filesModel = {
      aggregate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    storageService = {
      deleteObject: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('bootstrap-jwt-token'),
      decode: jest.fn().mockReturnValue({ iat: 1000, exp: 4600 }),
    };

    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    service = new SessionsService(
      sessionsModel as never,
      filesModel as never,
      configService,
      storageService as never,
      jwtService as never,
    );
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
      accessToken: 'bootstrap-jwt-token',
      expiresIn: 3600,
    });
    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        email: 'user@example.com',
        sessionId: 'BBBBBBB3',
        type: 'session_bootstrap',
      },
      { expiresIn: '1h' },
    );
  });

  it('deletes session and cascades delete to uploaded files', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'AAAAAAA2',
        email: 'user@example.com',
      }),
    });

    const uploadedFiles = [
      { _id: 'file-1', s3Bucket: 'bucket-a', s3Key: 'key-1', status: FileStatus.Uploaded },
      { _id: 'file-2', s3Bucket: 'bucket-a', s3Key: 'key-2', status: FileStatus.Uploaded },
    ];
    filesModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue(uploadedFiles),
    });

    const result = await service.deleteActiveSessionById('AAAAAAA2', { email: 'user@example.com' });

    expect(result).toEqual({ deleted: true });
    expect(sessionsModel.findOne).toHaveBeenCalledWith({
      sessionId: 'AAAAAAA2',
      email: 'user@example.com',
      status: { $ne: 'deleted' },
    });
    expect(sessionsModel.updateOne).toHaveBeenCalledWith(
      { sessionId: 'AAAAAAA2', email: 'user@example.com' },
      { $set: { status: 'deleted', deletedAt: expect.any(Date) } },
    );
    expect(filesModel.find).toHaveBeenCalledWith({
      sessionId: 'AAAAAAA2',
      status: 'uploaded',
    });
    expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledWith('bucket-a', 'key-1');
    expect(storageService.deleteObject).toHaveBeenCalledWith('bucket-a', 'key-2');
    expect(filesModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['file-1', 'file-2'] } },
      { $set: { status: 'deleted', deletedAt: expect.any(Date) } },
    );
  });

  it('continues cascade when S3 delete fails for one file', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'AAAAAAA2',
        email: 'user@example.com',
      }),
    });

    const uploadedFiles = [
      { _id: 'file-1', s3Bucket: 'bucket-a', s3Key: 'key-1', status: FileStatus.Uploaded },
      { _id: 'file-2', s3Bucket: 'bucket-a', s3Key: 'key-2', status: FileStatus.Uploaded },
    ];
    filesModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue(uploadedFiles),
    });

    storageService.deleteObject
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await service.deleteActiveSessionById('AAAAAAA2', { email: 'user@example.com' });

    expect(result).toEqual({ deleted: true });
    expect(storageService.deleteObject).toHaveBeenCalledTimes(2);
    expect(filesModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['file-1', 'file-2'] } },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'deleted' }) }),
    );
  });

  it('includes uploaded file count when listing active sessions', async () => {
    sessionsModel.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            sessionId: 'SESS1111',
            createdAt: new Date('2026-02-17T20:00:00.000Z'),
            expiresAt: new Date('2026-02-24T20:00:00.000Z'),
            status: SessionStatus.Active,
          },
          {
            sessionId: 'SESS2222',
            createdAt: new Date('2026-02-16T20:00:00.000Z'),
            expiresAt: new Date('2026-02-23T20:00:00.000Z'),
            status: SessionStatus.Active,
          },
        ]),
      }),
    });

    filesModel.aggregate.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        { _id: 'SESS1111', count: 3 },
      ]),
    });

    const result = await service.listActiveSessionsForEmail('User@example.com');

    expect(filesModel.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          sessionId: { $in: ['SESS1111', 'SESS2222'] },
          status: 'uploaded',
        },
      },
      {
        $group: {
          _id: '$sessionId',
          count: { $sum: 1 },
        },
      },
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        sessionId: 'SESS1111',
        uploadedFileCount: 3,
      }),
      expect.objectContaining({
        sessionId: 'SESS2222',
        uploadedFileCount: 0,
      }),
    ]);
  });

  it('includes uploaded file count when loading a single active session', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'SESS3333',
        createdAt: new Date('2026-02-18T01:00:00.000Z'),
        expiresAt: new Date('2026-02-25T01:00:00.000Z'),
        status: SessionStatus.Active,
      }),
    });

    filesModel.aggregate.mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        { _id: 'SESS3333', count: 2 },
      ]),
    });

    const result = await service.findActiveSessionByIdAndEmail('SESS3333', 'user@example.com');

    expect(result).toEqual(
      expect.objectContaining({
        sessionId: 'SESS3333',
        uploadedFileCount: 2,
      }),
    );
  });
});
