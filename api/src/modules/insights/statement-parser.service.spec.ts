import { sha256Hex } from '../../common/utils/hash.util';
import { AccountType } from '../../db/schemas/file.schema';
import { StatementParserService } from './statement-parser.service';

describe('StatementParserService', () => {
  let service: StatementParserService;

  beforeEach(() => {
    service = new StatementParserService();
  });

  it('extracts statement metadata and transactions from raw text', () => {
    const text = `
      Example Bank
      Statement Period: 01/01/2026 - 01/31/2026
      Account Number: ****1234
      Opening Balance $1,200.00
      Closing Balance $950.00
      Minimum Payment Due $35.00
      Interest Charged $12.34
      Fees Charged $1.50
      APR 24.99%

      01/03 Grocery Store #123 45.67
      01/07 PAYCHECK ACME CORP 2500.00 CR
      01/12 Utility Payment 89.22
    `;

    const parsed = service.parseText('file-1', text, {
      accountType: AccountType.Checking,
      referenceDate: new Date('2026-02-15T00:00:00.000Z'),
    });

    expect(parsed.statementMeta.accountLast4).toBe('1234');
    expect(parsed.statementMeta.statementPeriodStart?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.statementMeta.statementPeriodEnd?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(parsed.statementMeta.openingBalance).toBe(1200);
    expect(parsed.statementMeta.closingBalance).toBe(950);
    expect(parsed.statementMeta.minPayment).toBe(35);
    expect(parsed.statementMeta.interestCharged).toBe(12.34);
    expect(parsed.statementMeta.feesCharged).toBe(1.5);
    expect(parsed.statementMeta.apr).toBe(24.99);
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.transactions[0].descriptionNormalized).toBe('GROCERY STORE 123');
    expect(parsed.transactions[0].amount).toBe(-45.67);
    expect(parsed.transactions[1].amount).toBe(2500);
    expect(parsed.totals.totalDebits).toBe(134.89);
    expect(parsed.totals.totalCredits).toBe(2500);
    expect(parsed.confidence.overall).toBeGreaterThan(0.5);
  });

  it('normalizes description and computes stable hash from normalized fields', () => {
    const parsed = service.parseText('file-2', '01/15 Coffee-Shop! #987 12.50', {
      accountType: AccountType.Credit,
      referenceDate: new Date('2026-01-31T00:00:00.000Z'),
    });

    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].descriptionNormalized).toBe('COFFEE SHOP 987');
    expect(parsed.transactions[0].amount).toBe(-12.5);
    expect(parsed.transactions[0].hash).toBe(
      sha256Hex('file-2|2026-01-15|COFFEE SHOP 987|-12.50'),
    );
  });

  it('deduplicates identical rows within the same file parse', () => {
    const parsed = service.parseText(
      'file-3',
      `
        01/10 Online Purchase 10.00
        01/10 Online Purchase 10.00
      `,
      {
        accountType: AccountType.Credit,
        referenceDate: new Date('2026-01-31T00:00:00.000Z'),
      },
    );

    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.totals.totalDebits).toBe(10);
  });

  it('returns low confidence with helpful notes when extraction is empty', () => {
    const parsed = service.parseText('file-4', '', {
      referenceDate: new Date('2026-01-31T00:00:00.000Z'),
    });

    expect(parsed.transactions).toHaveLength(0);
    expect(parsed.confidence.overall).toBeLessThan(0.4);
    expect(parsed.confidence.notes).toContain('No transaction rows were detected.');
  });

  it('does not misread interest charge calculation context as interest charged amount', () => {
    const parsed = service.parseText(
      'file-5',
      `
        AMERICAN EXPRESS
        Interest Charge Calculation
        New Balance $7,937.71
        Interest Charged $23.00
        Minimum Payment Due $261.41
        APR 29.99%
      `,
      {
        accountType: AccountType.Credit,
        referenceDate: new Date('2026-02-15T00:00:00.000Z'),
      },
    );

    expect(parsed.statementMeta.interestCharged).toBe(23);
    expect(parsed.statementMeta.minPayment).toBe(261.41);
    expect(parsed.statementMeta.apr).toBe(29.99);
  });
});
