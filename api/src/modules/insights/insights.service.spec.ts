import { Types } from 'mongoose';
import { AccountType, FileStatus } from '../../db/schemas/file.schema';
import { ParsedStatementStatus } from '../../db/schemas/parsed-statement.schema';
import type { AccessTokenPayload } from '../auth/auth.service';
import { InsightsService } from './insights.service';
import type { ParsedStatementDraft } from './statement-parser.service';

function createFindChain<T>(rows: T[]) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function createParsedDraft(params: {
  confidence: number;
  transactions: ParsedStatementDraft['transactions'];
}): ParsedStatementDraft {
  return {
    statementMeta: {
      currency: 'USD',
    },
    totals: {},
    confidence: {
      overall: params.confidence,
      notes: [],
    },
    transactions: params.transactions,
  };
}

describe('InsightsService queue parse persistence', () => {
  const user: AccessTokenPayload = {
    email: 'user@example.com',
    sessionId: 'SESSION123',
    type: 'continue_session',
  };

  let filesModel: { find: jest.Mock };
  let parsedStatementsModel: { bulkWrite: jest.Mock; updateOne: jest.Mock };
  let transactionsModel: { bulkWrite: jest.Mock; find: jest.Mock; findById: jest.Mock };
  let labelsModel: { create: jest.Mock; findOne: jest.Mock; find: jest.Mock; updateOne: jest.Mock };
  let transactionLabelsModel: { updateOne: jest.Mock; deleteOne: jest.Mock; find: jest.Mock };
  let labelRulesModel: Record<string, jest.Mock>;
  let sessionsService: { getActiveSessionById: jest.Mock };
  let statementParserService: { getParserVersion: jest.Mock; parsePdfBuffer: jest.Mock };
  let storageService: { getObject: jest.Mock };
  let service: InsightsService;

  beforeEach(() => {
    filesModel = {
      find: jest.fn(),
    };
    parsedStatementsModel = {
      bulkWrite: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
    };
    transactionsModel = {
      bulkWrite: jest.fn().mockResolvedValue({}),
      find: jest.fn(),
      findById: jest.fn(),
    };
    labelsModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
    };
    transactionLabelsModel = {
      updateOne: jest.fn(),
      deleteOne: jest.fn(),
      find: jest.fn(),
    };
    labelRulesModel = {
      create: jest.fn(),
      find: jest.fn(),
    };
    sessionsService = {
      getActiveSessionById: jest.fn().mockResolvedValue({}),
    };
    statementParserService = {
      getParserVersion: jest.fn().mockReturnValue('v1'),
      parsePdfBuffer: jest.fn(),
    };
    storageService = {
      getObject: jest.fn().mockResolvedValue({
        body: Buffer.from('pdf'),
        contentType: 'application/pdf',
      }),
    };

    service = new InsightsService(
      filesModel as never,
      parsedStatementsModel as never,
      transactionsModel as never,
      labelsModel as never,
      transactionLabelsModel as never,
      labelRulesModel as never,
      sessionsService as never,
      statementParserService as never,
      storageService as never,
    );
  });

  it('stores parsed status and upserts transactions for high-confidence parse', async () => {
    const fileId = 'file-alpha';
    filesModel.find.mockReturnValue(createFindChain([{
      _id: new Types.ObjectId(),
      fileId,
      accountType: AccountType.Credit,
      mimeType: 'application/pdf',
      s3Bucket: 'bucket',
      s3Key: 'SESSION123/credit/file-alpha.pdf',
      status: FileStatus.Uploaded,
      byteSize: 1024,
    }]));

    statementParserService.parsePdfBuffer.mockResolvedValue(createParsedDraft({
      confidence: 0.83,
      transactions: [{
        txnDate: new Date('2026-01-12T00:00:00.000Z'),
        descriptionRaw: 'Coffee shop',
        descriptionNormalized: 'COFFEE SHOP',
        amount: -8.45,
        hash: 'hash-1',
      }],
    }));

    const result = await service.queueParseForSession('SESSION123', [fileId], user);

    expect(result.queued).toEqual([{
      fileId,
      status: ParsedStatementStatus.Processing,
    }]);
    expect(result.skipped).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(storageService.getObject).toHaveBeenCalledWith('bucket', 'SESSION123/credit/file-alpha.pdf');
    expect(transactionsModel.bulkWrite).toHaveBeenCalledWith(
      [expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { hash: 'hash-1' },
          upsert: true,
        }),
      })],
      { ordered: false },
    );
    expect(parsedStatementsModel.updateOne).toHaveBeenCalledWith(
      { fileId },
      expect.objectContaining({
        $set: expect.objectContaining({
          sessionId: 'SESSION123',
          fileId,
          status: ParsedStatementStatus.Parsed,
          parserVersion: 'v1',
        }),
      }),
      { upsert: true },
    );
  });

  it('stores needs_review when transactions exist but confidence is low', async () => {
    const fileId = 'file-beta';
    filesModel.find.mockReturnValue(createFindChain([{
      _id: new Types.ObjectId(),
      fileId,
      accountType: AccountType.Checking,
      mimeType: 'application/pdf',
      s3Bucket: 'bucket',
      s3Key: 'SESSION123/checking/file-beta.pdf',
      status: FileStatus.Uploaded,
      byteSize: 1024,
    }]));

    statementParserService.parsePdfBuffer.mockResolvedValue(createParsedDraft({
      confidence: 0.42,
      transactions: [{
        txnDate: new Date('2026-01-12T00:00:00.000Z'),
        descriptionRaw: 'Utility payment',
        descriptionNormalized: 'UTILITY PAYMENT',
        amount: -85.11,
        hash: 'hash-2',
      }],
    }));

    await service.queueParseForSession('SESSION123', [fileId], user);

    expect(parsedStatementsModel.updateOne).toHaveBeenCalledWith(
      { fileId },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: ParsedStatementStatus.NeedsReview,
        }),
      }),
      { upsert: true },
    );
  });

  it('stores failed when parser returns zero transactions', async () => {
    const fileId = 'file-gamma';
    filesModel.find.mockReturnValue(createFindChain([{
      _id: new Types.ObjectId(),
      fileId,
      accountType: AccountType.Savings,
      mimeType: 'application/pdf',
      s3Bucket: 'bucket',
      s3Key: 'SESSION123/savings/file-gamma.pdf',
      status: FileStatus.Uploaded,
      byteSize: 1024,
    }]));

    statementParserService.parsePdfBuffer.mockResolvedValue(createParsedDraft({
      confidence: 0.9,
      transactions: [],
    }));

    await service.queueParseForSession('SESSION123', [fileId], user);

    expect(transactionsModel.bulkWrite).not.toHaveBeenCalled();
    expect(parsedStatementsModel.updateOne).toHaveBeenCalledWith(
      { fileId },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: ParsedStatementStatus.Failed,
        }),
      }),
      { upsert: true },
    );
  });

  it('keeps oversized files pending and reports a deferred reason', async () => {
    const fileId = 'file-oversized';
    filesModel.find.mockReturnValue(createFindChain([{
      _id: new Types.ObjectId(),
      fileId,
      accountType: AccountType.Credit,
      mimeType: 'application/pdf',
      s3Bucket: 'bucket',
      s3Key: 'SESSION123/credit/file-oversized.pdf',
      status: FileStatus.Uploaded,
      byteSize: 7 * 1024 * 1024,
    }]));

    const result = await service.queueParseForSession('SESSION123', [fileId], user);

    expect(result.queued).toEqual([{
      fileId,
      status: ParsedStatementStatus.Pending,
    }]);
    expect(result.deferred).toEqual([{
      fileId,
      reason: expect.stringContaining('Queued for background parsing because file is'),
    }]);
    expect(statementParserService.parsePdfBuffer).not.toHaveBeenCalled();
    expect(storageService.getObject).not.toHaveBeenCalled();
  });

  it('marks parse as failed with timeout note when inline parse exceeds timeout', async () => {
    const fileId = 'file-timeout';
    filesModel.find.mockReturnValue(createFindChain([{
      _id: new Types.ObjectId(),
      fileId,
      accountType: AccountType.Checking,
      mimeType: 'application/pdf',
      s3Bucket: 'bucket',
      s3Key: 'SESSION123/checking/file-timeout.pdf',
      status: FileStatus.Uploaded,
      byteSize: 1024,
    }]));

    statementParserService.parsePdfBuffer.mockRejectedValue(
      new Error('PARSE_TIMEOUT:15000'),
    );

    await service.queueParseForSession('SESSION123', [fileId], user);

    expect(parsedStatementsModel.updateOne).toHaveBeenCalledWith(
      { fileId },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: ParsedStatementStatus.Failed,
          confidence: expect.objectContaining({
            notes: [expect.stringContaining('timed out after')],
          }),
        }),
      }),
      { upsert: true },
    );
  });

  it('returns transactions with persisted label ids', async () => {
    const firstTxnId = new Types.ObjectId();
    const secondTxnId = new Types.ObjectId();
    const firstLabelId = new Types.ObjectId();
    const secondLabelId = new Types.ObjectId();
    transactionsModel.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([
            {
              _id: firstTxnId,
              accountType: 'checking',
              descriptionRaw: 'Coffee Shop',
              descriptionNormalized: 'COFFEE SHOP',
              amount: -12.5,
            },
            { _id: secondTxnId, descriptionRaw: 'Paycheck', amount: 1000 },
          ]),
        }),
      }),
    });
    transactionLabelsModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([
            { transactionId: firstTxnId.toString(), labelId: 'label-rent' },
            { transactionId: firstTxnId.toString(), labelId: 'label-food' },
          ]),
        }),
      }),
    });
    labelsModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([
            { _id: firstLabelId.toString() },
            { _id: secondLabelId.toString() },
          ]),
        }),
      }),
    });
    labelRulesModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([
            {
              labelId: firstLabelId.toString(),
              applyMode: 'suggest',
              match: {
                descriptionContains: ['COFFEE'],
                direction: 'out',
                accountType: 'checking',
              },
            },
            {
              labelId: secondLabelId.toString(),
              applyMode: 'auto',
              match: {
                descriptionContains: ['PAYCHECK'],
                direction: 'in',
              },
            },
          ]),
        }),
      }),
    });

    const result = await service.listTransactions('SESSION123', 'file-alpha', user);

    expect(result).toEqual([
      expect.objectContaining({
        id: firstTxnId.toString(),
        labelIds: ['label-rent', 'label-food'],
        suggestedLabels: [
          {
            labelId: firstLabelId.toString(),
            applyMode: 'suggest',
          },
        ],
      }),
      expect.objectContaining({
        id: secondTxnId.toString(),
        labelIds: [],
        suggestedLabels: [
          {
            labelId: secondLabelId.toString(),
            applyMode: 'auto',
          },
        ],
      }),
    ]);
    expect(filesModel.find).not.toHaveBeenCalled();
  });

  it('returns labels for the authenticated owner', async () => {
    const labelId = new Types.ObjectId();
    labelsModel.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            _id: labelId,
            ownerEmail: user.email,
            name: 'PAYCHECK',
            type: 'system',
            isIncome: true,
            createdAt: new Date('2026-02-22T00:00:00.000Z'),
          },
        ]),
      }),
    });

    const result = await service.listLabels(user);

    expect(labelsModel.updateOne).toHaveBeenCalledWith(
      {
        ownerEmail: user.email,
        type: 'system',
        name: 'PAYCHECK',
      },
      {
        $set: {
          isIncome: true,
        },
        $setOnInsert: {
          ownerEmail: user.email,
          type: 'system',
          name: 'PAYCHECK',
        },
      },
      { upsert: true },
    );
    expect(labelsModel.find).toHaveBeenCalledWith({ ownerEmail: user.email });
    expect(result).toEqual([
      {
        id: labelId.toString(),
        ownerEmail: user.email,
        name: 'PAYCHECK',
        type: 'system',
        isIncome: true,
        createdAt: '2026-02-22T00:00:00.000Z',
      },
    ]);
  });

  it('persists label attachment to a transaction', async () => {
    const transactionId = new Types.ObjectId();
    const labelId = new Types.ObjectId();
    transactionsModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: transactionId,
          sessionId: 'SESSION123',
        }),
      }),
    });
    labelsModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: labelId,
          ownerEmail: user.email,
        }),
      }),
    });
    transactionLabelsModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({}),
    });

    const result = await service.attachLabelToTransaction(
      transactionId.toString(),
      labelId.toString(),
      user,
    );

    expect(transactionLabelsModel.updateOne).toHaveBeenCalledWith(
      {
        transactionId: transactionId.toString(),
        labelId: labelId.toString(),
      },
      {
        $setOnInsert: {
          sessionId: 'SESSION123',
          transactionId: transactionId.toString(),
          labelId: labelId.toString(),
        },
      },
      { upsert: true },
    );
    expect(result).toEqual({
      attached: true,
      transactionId: transactionId.toString(),
      labelId: labelId.toString(),
    });
  });

  it('removes a persisted label attachment from a transaction', async () => {
    const transactionId = new Types.ObjectId();
    const labelId = new Types.ObjectId();
    transactionsModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: transactionId,
          sessionId: 'SESSION123',
        }),
      }),
    });
    transactionLabelsModel.deleteOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    });

    const result = await service.removeLabelFromTransaction(
      transactionId.toString(),
      labelId.toString(),
      user,
    );

    expect(transactionLabelsModel.deleteOne).toHaveBeenCalledWith({
      transactionId: transactionId.toString(),
      labelId: labelId.toString(),
    });
    expect(result).toEqual({
      removed: true,
      transactionId: transactionId.toString(),
      labelId: labelId.toString(),
    });
  });
});
