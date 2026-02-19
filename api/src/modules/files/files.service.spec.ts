import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileCategory } from '../../db/schemas/file.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { FilesService, MultipartFile } from './files.service';

describe('FilesService', () => {
  let service: FilesService;
  let filesModel: {
    find: jest.Mock;
    updateMany: jest.Mock;
  };
  let sessionsModel: {
    findOne: jest.Mock;
  };
  let storageService: {
    uploadObject: jest.Mock;
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
    filesModel = {
      find: jest.fn(),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }),
    };

    sessionsModel = {
      findOne: jest.fn(),
    };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'S3_BUCKET_NAME') {
          return 'balance-statements';
        }
        if (key === 'MAX_FILES_PER_UPLOAD') {
          return '10';
        }
        if (key === 'MAX_FILE_SIZE_MB') {
          return '15';
        }
        return undefined;
      }),
    } as unknown as ConfigService;

    storageService = {
      uploadObject: jest.fn(),
      deleteObject: jest.fn(),
    };

    mockExistingSessionFiles([]);

    service = new FilesService(
      filesModel as never,
      sessionsModel as never,
      configService,
      storageService as never,
    );
  });

  function mockExistingSessionFiles(existingFiles: Array<{ originalName?: string }>) {
    const exec = jest.fn().mockResolvedValue(existingFiles);
    const lean = jest.fn().mockReturnValue({ exec });
    const select = jest.fn().mockReturnValue({ lean });
    filesModel.find.mockReturnValue({ select });
  }

  it('rejects non-pdf files', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'notes.txt',
      mimetype: 'text/plain',
      size: 128,
      buffer: Buffer.from('not-a-pdf'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toEqual([
      {
        originalName: 'notes.txt',
        reason: 'Only application/pdf files are accepted.',
      },
    ]);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('blocks upload to a session owned by another user', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    const user: AccessTokenPayload = {
      email: 'intruder@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'statement.pdf',
      mimetype: 'application/pdf',
      size: 256,
      buffer: Buffer.from('pdf-bytes'),
    }];

    await expect(service.uploadFilesToSession('ABC12345', user, files)).rejects.toBeInstanceOf(NotFoundException);

    const sessionQuery = sessionsModel.findOne.mock.calls[0][0];
    expect(sessionQuery.sessionId).toBe('ABC12345');
    expect(sessionQuery.email).toBe('intruder@example.com');
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('detects credit statement type when text contains minimum payment', () => {
    const detection = (service as any).detectStatementTypeFromText(
      'Your minimum payment is due on 02/20. This credit card statement is ready.',
    );

    expect(detection.autoDetectedType).toBe('credit');
  });

  it('detects unknown statement type for random text', () => {
    const detection = (service as any).detectStatementTypeFromText(
      'lorem ipsum random content with no banking keywords',
    );

    expect(detection.autoDetectedType).toBe('unknown');
  });

  it('rejects upload when a file with the same name already exists in the session', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });
    mockExistingSessionFiles([{ originalName: 'statement.pdf' }]);

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'statement.pdf',
      mimetype: 'application/pdf',
      size: 256,
      buffer: Buffer.from('pdf-bytes'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toEqual([
      {
        originalName: 'statement.pdf',
        reason: 'A file with this name already exists in this session.',
      },
    ]);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('treats file names as case-insensitive when preventing duplicates', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });
    mockExistingSessionFiles([{ originalName: 'Statement.PDF' }]);

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'statement.pdf',
      mimetype: 'application/pdf',
      size: 256,
      buffer: Buffer.from('pdf-bytes'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toEqual([
      {
        originalName: 'statement.pdf',
        reason: 'A file with this name already exists in this session.',
      },
    ]);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('returns detection previews before upload', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'notes.txt',
      mimetype: 'text/plain',
      size: 64,
      buffer: Buffer.from('plain-text'),
    }];

    const result = await service.detectFilesForSession('ABC12345', user, files);

    expect(result.files).toEqual([
      {
        originalName: 'notes.txt',
        autoDetectedType: 'unknown',
        detectionConfidence: 0,
        isLikelyStatement: false,
      },
    ]);
  });

  it('moves unfiled files to a folder and aligns statement type', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });

    filesModel.updateMany.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    });

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };

    const result = await service.moveFilesToCategory(
      'ABC12345',
      ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      FileCategory.Checking,
      user,
    );

    expect(filesModel.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'] },
        sessionId: 'ABC12345',
        status: { $ne: 'deleted' },
      },
      {
        $set: {
          category: 'checking',
          statementType: 'checking',
          confirmedByUser: true,
        },
      },
    );
    expect(result).toEqual({ movedCount: 2, category: 'checking' });
  });

  it('moves files to root without changing statement type', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });

    filesModel.updateMany.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    });

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };

    const result = await service.moveFilesToCategory(
      'ABC12345',
      ['507f1f77bcf86cd799439011'],
      FileCategory.Unfiled,
      user,
    );

    expect(filesModel.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['507f1f77bcf86cd799439011'] },
        sessionId: 'ABC12345',
        status: { $ne: 'deleted' },
      },
      {
        $set: {
          category: 'unfiled',
          confirmedByUser: true,
        },
      },
    );
    expect(result).toEqual({ movedCount: 1, category: 'unfiled' });
  });

  it('chooses a known type when multiple categories tie on keyword count', () => {
    const detection = (service as any).detectStatementTypeFromText(
      'credit card summary and checking account overview',
    );

    expect(['credit', 'checking', 'savings']).toContain(detection.autoDetectedType);
    expect(detection.isLikelyStatement).toBe(true);
  });

  it('prefers type with stronger repeated keyword mentions', () => {
    const detection = (service as any).detectStatementTypeFromText(
      'checking account activity. checking account transfers. minimum payment notice.',
    );

    expect(detection.autoDetectedType).toBe('checking');
    expect(detection.isLikelyStatement).toBe(true);
  });
});
