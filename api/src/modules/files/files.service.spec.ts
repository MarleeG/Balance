import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccessTokenPayload } from '../auth/auth.service';
import { FilesService, MultipartFile } from './files.service';

describe('FilesService', () => {
  let service: FilesService;
  let sessionsModel: {
    findOne: jest.Mock;
  };
  let storageService: {
    uploadObject: jest.Mock;
    deleteObject: jest.Mock;
  };

  beforeEach(() => {
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

    service = new FilesService(
      {} as never,
      sessionsModel as never,
      configService,
      storageService as never,
    );
  });

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
});
