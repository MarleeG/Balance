import { ConfigService } from '@nestjs/config';
import { FileStatus } from '../../db/schemas/file.schema';
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
    findOne: jest.Mock;
    updateOne: jest.Mock;
  };
  let filesModel: {
    find: jest.Mock;
    updateMany: jest.Mock;
  };
  let storageService: {
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
    sessionsModel = {
      exists: jest.fn(),
      create: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    filesModel = {
      find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    storageService = {
      deleteObject: jest.fn(),
    };

    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    service = new SessionsService(
      sessionsModel as never,
      filesModel as never,
      configService,
      storageService as never,
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
    });
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
    expect(storageService.deleteObject).toHaveBeenNthCalledWith(1, 'bucket-a', 'key-1');
    expect(storageService.deleteObject).toHaveBeenNthCalledWith(2, 'bucket-a', 'key-2');
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
});
