import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileCategory, StatementType } from '../../db/schemas/file.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { FilesService, MultipartFile } from './files.service';

describe('FilesService', () => {
  let service: FilesService;
  let filesModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
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
      findOne: jest.fn(),
      exists: jest.fn(),
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

  function mockExistingSessionFiles(existingFiles: Array<{ originalName?: string; displayName?: string }>) {
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

  it('rejects files larger than 25MB', async () => {
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
      originalname: 'large-statement.pdf',
      mimetype: 'application/pdf',
      size: 26 * 1024 * 1024,
      buffer: Buffer.from('pdf-bytes'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toEqual([
      {
        originalName: 'large-statement.pdf',
        reason: 'File exceeds max size (25MB).',
      },
    ]);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('rejects upload when file name exceeds 80 characters for display-name rules', async () => {
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
      originalname: `${'a'.repeat(81)}.pdf`,
      mimetype: 'application/pdf',
      size: 1024,
      buffer: Buffer.from('pdf-bytes'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toEqual([
      {
        originalName: `${'a'.repeat(81)}.pdf`,
        reason: 'Display name must be 80 characters or fewer.',
      },
    ]);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('rejects files beyond the max file count per request', async () => {
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

    const files: MultipartFile[] = Array.from({ length: 11 }, (_, index) => ({
      originalname: `statement-${index + 1}.txt`,
      mimetype: 'text/plain',
      size: 1024,
      buffer: Buffer.from('not-a-pdf'),
    }));

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.uploaded).toEqual([]);
    expect(result.rejected).toHaveLength(11);
    expect(result.rejected.some((item) => item.reason === 'Exceeded max file count (10).')).toBe(true);
    expect(storageService.uploadObject).not.toHaveBeenCalled();
  });

  it('builds S3 key from session id, account type, and file id only', () => {
    const key = (service as any).buildS3Key(
      'ABC12345',
      StatementType.Credit,
      '507f1f77bcf86cd799439011',
    );

    expect(key).toBe('ABC12345/credit/507f1f77bcf86cd799439011.pdf');
    expect(key).not.toContain('statement');
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

  it('allows upload with a warning when matching original name exists but was renamed', async () => {
    sessionsModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        sessionId: 'ABC12345',
        email: 'user@example.com',
      }),
    });
    mockExistingSessionFiles([{ originalName: 'statement.pdf', displayName: 'February-2026.pdf' }]);

    const createdFile = {
      _id: { toString: () => '507f1f77bcf86cd799439099' },
      originalName: 'statement.pdf',
      displayName: 'statement.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unknown,
      autoDetectedType: StatementType.Unknown,
      detectionConfidence: 0,
      isLikelyStatement: false,
      status: 'pending',
      s3Key: '',
      s3Bucket: 'balance-statements',
      uploadedAt: new Date('2026-02-21T10:00:00.000Z'),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const filesModelCtor: any = jest.fn().mockImplementation(() => createdFile);
    filesModelCtor.find = filesModel.find;
    filesModelCtor.findOne = filesModel.findOne;
    filesModelCtor.exists = filesModel.exists;
    filesModelCtor.updateMany = filesModel.updateMany;
    filesModelCtor.updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) });
    (service as any).filesModel = filesModelCtor;
    jest.spyOn(service as any, 'detectStatementTypeFromPdf').mockResolvedValue({
      autoDetectedType: StatementType.Unknown,
      detectionConfidence: 0,
      isLikelyStatement: false,
    });

    const user: AccessTokenPayload = {
      email: 'user@example.com',
      type: 'find_sessions',
    };
    const files: MultipartFile[] = [{
      originalname: 'statement.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      buffer: Buffer.from('pdf-bytes'),
    }];

    const result = await service.uploadFilesToSession('ABC12345', user, files);

    expect(result.rejected).toEqual([]);
    expect(result.uploaded).toHaveLength(1);
    expect(result.warnings).toContainEqual({
      originalName: 'statement.pdf',
      reason: 'Possible duplicate: this original filename matches an existing file renamed to "February-2026.pdf".',
    });
    expect(storageService.uploadObject).toHaveBeenCalledWith({
      bucket: 'balance-statements',
      key: 'ABC12345/unknown/507f1f77bcf86cd799439099.pdf',
      body: Buffer.from('pdf-bytes'),
      contentType: 'application/pdf',
    });
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
          accountType: 'checking',
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

  it('renames a file when the next name is unique in the session', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
    filesModel.exists.mockResolvedValue(null);
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

    const result = await service.updateFile(
      '507f1f77bcf86cd799439011',
      { originalName: 'statement-renamed.pdf' },
      user,
    );

    expect(filesModel.exists).toHaveBeenCalledWith({
      sessionId: 'ABC12345',
      status: { $ne: 'deleted' },
      _id: { $ne: '507f1f77bcf86cd799439011' },
      originalName: { $regex: '^statement-renamed\\.pdf$', $options: 'i' },
    });
    expect(fileDoc.originalName).toBe('statement-renamed.pdf');
    expect(fileDoc.confirmedByUser).toBe(true);
    expect(fileDoc.save).toHaveBeenCalled();
    expect(result).toEqual({
      id: '507f1f77bcf86cd799439011',
      originalName: 'statement-renamed.pdf',
      displayName: 'statement-renamed.pdf',
      statementType: 'unknown',
      category: 'unfiled',
      confirmedByUser: true,
    });
  });

  it('rejects rename when another file already uses that name in the session', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
    filesModel.exists.mockResolvedValue({ _id: '507f1f77bcf86cd799439012' });
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

    await expect(
      service.updateFile(
        '507f1f77bcf86cd799439011',
        { originalName: 'statement-renamed.pdf' },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fileDoc.save).not.toHaveBeenCalled();
  });

  it('rejects rename when attempting to change file extension', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
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

    await expect(
      service.updateFile(
        '507f1f77bcf86cd799439011',
        { originalName: 'statement-old.csv' },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fileDoc.save).not.toHaveBeenCalled();
  });

  it('normalizes and saves display name updates', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      displayName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
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

    const result = await service.updateFile(
      '507f1f77bcf86cd799439011',
      { displayName: '   My@@   Statement   (2026)   ' },
      user,
    );

    expect(fileDoc.displayName).toBe('My-- Statement (2026)');
    expect(fileDoc.save).toHaveBeenCalled();
    expect(result).toEqual({
      id: '507f1f77bcf86cd799439011',
      originalName: 'statement-old.pdf',
      displayName: 'My-- Statement (2026)',
      statementType: 'unknown',
      category: 'unfiled',
      confirmedByUser: true,
    });
  });

  it('rejects display name updates that are only whitespace', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      displayName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
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

    await expect(
      service.updateFile(
        '507f1f77bcf86cd799439011',
        { displayName: '     ' },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fileDoc.save).not.toHaveBeenCalled();
  });

  it('rejects display name updates longer than 80 characters after normalization', async () => {
    const fileDoc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      sessionId: 'ABC12345',
      originalName: 'statement-old.pdf',
      displayName: 'statement-old.pdf',
      statementType: StatementType.Unknown,
      category: FileCategory.Unfiled,
      confirmedByUser: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    filesModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(fileDoc),
    });
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

    await expect(
      service.updateFile(
        '507f1f77bcf86cd799439011',
        { displayName: 'a'.repeat(81) },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fileDoc.save).not.toHaveBeenCalled();
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
