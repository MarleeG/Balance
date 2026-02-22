import { Injectable } from '@nestjs/common';
import { sha256Hex } from '../../common/utils/hash.util';
import { AccountType } from '../../db/schemas/file.schema';

const DATE_TOKEN_PATTERN = '(?:\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
const TRANSACTION_LINE_REGEX = new RegExp(
  `^(?<txnDate>\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)\\s+`
    + `(?:(?<postDate>\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)\\s+)?`
    + `(?<description>.+?)\\s+`
    + `(?<amount>\\(?-?\\$?\\d[\\d,]*(?:\\.\\d{2})?\\)?)`
    + `(?:\\s+(?<balance>\\(?-?\\$?\\d[\\d,]*(?:\\.\\d{2})?\\)?))?`
    + `(?:\\s+(?<direction>CR|DR|CREDIT|DEBIT))?$`,
  'i',
);
const HEADER_LINE_KEYWORDS = [
  'date description amount',
  'date posted',
  'transactions',
  'transaction activity',
  'daily ledger',
  'description amount',
  'balance summary',
  'payment due',
];
const INCOME_KEYWORDS = ['PAYCHECK', 'PAYROLL', 'DIRECT DEP', 'DEPOSIT', 'ACH CREDIT', 'REFUND', 'INTEREST'];
const EXPENSE_KEYWORDS = ['PURCHASE', 'POS', 'DEBIT', 'WITHDRAWAL', 'ATM', 'FEE', 'TRANSFER TO', 'PAYMENT'];
const SYSTEM_LINES_TO_SKIP = [
  'page ',
  'total ',
  'subtotal',
  'balance forward',
  'new balance',
  'ending balance',
  'beginning balance',
];

export const STATEMENT_PARSER_VERSION = 'v1';

export interface ParsedTransactionDraft {
  txnDate: Date;
  postDate?: Date;
  descriptionRaw: string;
  descriptionNormalized: string;
  amount: number;
  hash: string;
}

export interface StatementMetaDraft {
  institutionName?: string;
  accountLast4?: string;
  statementPeriodStart?: Date;
  statementPeriodEnd?: Date;
  currency: 'USD';
  openingBalance?: number;
  closingBalance?: number;
  minPayment?: number;
  interestCharged?: number;
  feesCharged?: number;
  apr?: number;
}

export interface StatementTotalsDraft {
  totalDebits?: number;
  totalCredits?: number;
}

export interface StatementConfidenceDraft {
  overall: number;
  notes: string[];
}

export interface ParsedStatementDraft {
  statementMeta: StatementMetaDraft;
  totals: StatementTotalsDraft;
  confidence: StatementConfidenceDraft;
  transactions: ParsedTransactionDraft[];
}

export interface ParseStatementOptions {
  accountType?: AccountType;
  referenceDate?: Date;
}

@Injectable()
export class StatementParserService {
  private pdfParsePolyfillsInitialized = false;

  getParserVersion(): string {
    return STATEMENT_PARSER_VERSION;
  }

  async parsePdfBuffer(
    fileId: string,
    pdfBuffer: Buffer,
    options?: ParseStatementOptions,
  ): Promise<ParsedStatementDraft> {
    const text = await this.extractPdfText(pdfBuffer);
    return this.parseText(fileId, text, options);
  }

  parseText(
    fileId: string,
    rawText: string,
    options?: ParseStatementOptions,
  ): ParsedStatementDraft {
    const referenceDate = options?.referenceDate ?? new Date();
    const accountType = options?.accountType;
    const normalizedText = this.normalizeExtractedText(rawText);
    const statementMeta = this.extractStatementMeta(normalizedText, referenceDate);

    const transactions = this.extractTransactions(
      fileId,
      normalizedText,
      statementMeta.statementPeriodEnd ?? referenceDate,
      accountType,
    );

    const totals = this.buildTotals(transactions);
    const confidence = this.buildConfidence({
      textLength: normalizedText.length,
      transactionCount: transactions.length,
      hasStatementPeriod: Boolean(statementMeta.statementPeriodStart && statementMeta.statementPeriodEnd),
      hasBalances: Boolean(
        typeof statementMeta.openingBalance === 'number' || typeof statementMeta.closingBalance === 'number',
      ),
      hasCreditDetails: Boolean(
        typeof statementMeta.minPayment === 'number'
        || typeof statementMeta.interestCharged === 'number'
        || typeof statementMeta.feesCharged === 'number'
        || typeof statementMeta.apr === 'number',
      ),
    });

    return {
      statementMeta,
      totals,
      confidence,
      transactions,
    };
  }

  private async extractPdfText(pdfBuffer: Buffer): Promise<string> {
    await this.ensurePdfParseRuntimePolyfills();

    let PDFParse: typeof import('pdf-parse').PDFParse;
    try {
      ({ PDFParse } = await import('pdf-parse'));
    } catch {
      return '';
    }

    const parser = new PDFParse({ data: pdfBuffer });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } catch {
      return '';
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private normalizeExtractedText(rawText: string): string {
    return rawText
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private extractStatementMeta(text: string, referenceDate: Date): StatementMetaDraft {
    const { statementPeriodStart, statementPeriodEnd } = this.extractStatementPeriod(text, referenceDate);

    return {
      institutionName: this.extractInstitutionName(text),
      accountLast4: this.extractAccountLast4(text),
      ...(statementPeriodStart ? { statementPeriodStart } : {}),
      ...(statementPeriodEnd ? { statementPeriodEnd } : {}),
      currency: 'USD',
      ...this.extractBalanceMeta(text),
      ...this.extractCreditMeta(text),
    };
  }

  private extractStatementPeriod(
    text: string,
    referenceDate: Date,
  ): { statementPeriodStart?: Date; statementPeriodEnd?: Date } {
    const patterns = [
      new RegExp(`statement\\s+period[^\\n\\dA-Za-z]*(?<start>${DATE_TOKEN_PATTERN})\\s*(?:-|to)\\s*(?<end>${DATE_TOKEN_PATTERN})`, 'i'),
      new RegExp(`period\\s+covered[^\\n\\dA-Za-z]*(?<start>${DATE_TOKEN_PATTERN})\\s*(?:-|to)\\s*(?<end>${DATE_TOKEN_PATTERN})`, 'i'),
      new RegExp(`from\\s+(?<start>${DATE_TOKEN_PATTERN})\\s+to\\s+(?<end>${DATE_TOKEN_PATTERN})`, 'i'),
      new RegExp(`(?<start>${DATE_TOKEN_PATTERN})\\s*(?:-|to)\\s*(?<end>${DATE_TOKEN_PATTERN})`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      const startToken = match?.groups?.start;
      const endToken = match?.groups?.end;
      if (!startToken || !endToken) {
        continue;
      }

      const statementPeriodStart = this.parseDateToken(startToken, referenceDate);
      const statementPeriodEnd = this.parseDateToken(endToken, referenceDate);
      if (statementPeriodStart && statementPeriodEnd) {
        return { statementPeriodStart, statementPeriodEnd };
      }
    }

    return {};
  }

  private extractInstitutionName(text: string): string | undefined {
    const ignoredFragments = ['statement', 'page ', 'account', 'customer service', 'www.', 'http', 'date'];
    const lines = text.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 3)
      .slice(0, 12);

    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (ignoredFragments.some((fragment) => lowered.includes(fragment))) {
        continue;
      }

      if (!/[a-z]/i.test(line)) {
        continue;
      }

      return line.slice(0, 80);
    }

    return undefined;
  }

  private extractAccountLast4(text: string): string | undefined {
    const match = text.match(/(?:account|acct)(?:\s*(?:number|no|#))?[^0-9]{0,8}(\d{4})(?!\d)/i);
    return match?.[1];
  }

  private extractBalanceMeta(text: string): { openingBalance?: number; closingBalance?: number } {
    const openingBalance = this.extractNamedAmount(
      text,
      /\bopening\s+balance\b[^0-9(\-$]*((?:\(?-?\$?\d[\d,]*(?:\.\d{2})?\)?))/i,
    );
    const closingBalance = this.extractNamedAmount(
      text,
      /\b(?:closing|ending|new)\s+balance\b[^0-9(\-$]*((?:\(?-?\$?\d[\d,]*(?:\.\d{2})?\)?))/i,
    );

    return {
      ...(typeof openingBalance === 'number' ? { openingBalance } : {}),
      ...(typeof closingBalance === 'number' ? { closingBalance } : {}),
    };
  }

  private extractCreditMeta(
    text: string,
  ): { minPayment?: number; interestCharged?: number; feesCharged?: number; apr?: number } {
    const minPayment = this.extractNamedAmount(
      text,
      /\bminimum\s+payment(?:\s+due)?\b[^0-9(\-$]*((?:\(?-?\$?\d[\d,]*(?:\.\d{2})?\)?))/i,
    );
    const interestCharged = this.extractNamedAmount(
      text,
      /\binterest\s+charg(?:ed|e|es)(?:\s+this\s+period)?\b[^0-9(\-$]*(\(?-?\$\d[\d,]*(?:\.\d{2})?\)?)/i,
    );
    const feesCharged = this.extractNamedAmount(
      text,
      /\bfees?\s+charg(?:ed|e|es)(?:\s+this\s+period)?\b[^0-9(\-$]*(\(?-?\$\d[\d,]*(?:\.\d{2})?\)?)/i,
    );

    const aprMatch = text.match(/\bapr\b[^0-9]*(\d{1,2}(?:\.\d{1,3})?)\s*%/i);
    const apr = aprMatch?.[1] ? Number.parseFloat(aprMatch[1]) : undefined;

    return {
      ...(typeof minPayment === 'number' ? { minPayment } : {}),
      ...(typeof interestCharged === 'number' ? { interestCharged } : {}),
      ...(typeof feesCharged === 'number' ? { feesCharged } : {}),
      ...(typeof apr === 'number' && Number.isFinite(apr) ? { apr } : {}),
    };
  }

  private extractNamedAmount(text: string, pattern: RegExp): number | undefined {
    const lines = text.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line) {
        continue;
      }

      const match = line.match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const parsed = this.parseAmountValue(match[1]);
      if (typeof parsed === 'number') {
        return parsed;
      }
    }

    return undefined;
  }

  private extractTransactions(
    fileId: string,
    text: string,
    referenceDate: Date,
    accountType?: AccountType,
  ): ParsedTransactionDraft[] {
    const transactions: ParsedTransactionDraft[] = [];
    const seenHashes = new Set<string>();

    const lines = text.split('\n');
    for (const rawLine of lines) {
      const normalizedLine = rawLine.replace(/\s+/g, ' ').trim();
      if (!normalizedLine) {
        continue;
      }

      const parsed = this.parseTransactionLine(fileId, normalizedLine, referenceDate, accountType);
      if (!parsed || seenHashes.has(parsed.hash)) {
        continue;
      }

      seenHashes.add(parsed.hash);
      transactions.push(parsed);
    }

    return transactions;
  }

  private parseTransactionLine(
    fileId: string,
    line: string,
    referenceDate: Date,
    accountType?: AccountType,
  ): ParsedTransactionDraft | null {
    const lowered = line.toLowerCase();
    if (SYSTEM_LINES_TO_SKIP.some((fragment) => lowered.includes(fragment))) {
      return null;
    }

    const lineMatch = line.match(TRANSACTION_LINE_REGEX);
    if (!lineMatch?.groups) {
      return null;
    }

    const descriptionRaw = lineMatch.groups.description?.trim();
    if (!descriptionRaw) {
      return null;
    }

    const descriptionLower = descriptionRaw.toLowerCase();
    if (HEADER_LINE_KEYWORDS.some((keyword) => descriptionLower.includes(keyword))) {
      return null;
    }

    const txnDate = this.parseDateToken(lineMatch.groups.txnDate, referenceDate);
    if (!txnDate) {
      return null;
    }

    const postDate = lineMatch.groups.postDate
      ? this.parseDateToken(lineMatch.groups.postDate, referenceDate)
      : undefined;
    const amount = this.parseSignedTransactionAmount(
      lineMatch.groups.amount,
      lineMatch.groups.direction,
      descriptionRaw,
      accountType,
    );
    if (typeof amount !== 'number') {
      return null;
    }

    const descriptionNormalized = this.normalizeDescription(descriptionRaw);
    if (!descriptionNormalized) {
      return null;
    }

    const hash = sha256Hex([
      fileId,
      this.toIsoDay(txnDate),
      descriptionNormalized,
      amount.toFixed(2),
    ].join('|'));

    return {
      txnDate,
      ...(postDate ? { postDate } : {}),
      descriptionRaw: descriptionRaw.replace(/\s+/g, ' '),
      descriptionNormalized,
      amount,
      hash,
    };
  }

  private parseSignedTransactionAmount(
    amountToken: string,
    directionToken: string | undefined,
    descriptionRaw: string,
    accountType?: AccountType,
  ): number | undefined {
    const parsedAmount = this.parseAmountValue(amountToken);
    if (typeof parsedAmount !== 'number') {
      return undefined;
    }

    const direction = directionToken?.trim().toUpperCase();
    if (direction === 'CR' || direction === 'CREDIT') {
      return Number(parsedAmount.toFixed(2));
    }
    if (direction === 'DR' || direction === 'DEBIT') {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }

    if (amountToken.includes('(') && amountToken.includes(')')) {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }
    if (amountToken.trim().startsWith('-')) {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }

    const normalizedDescription = this.normalizeDescription(descriptionRaw);
    if (INCOME_KEYWORDS.some((keyword) => normalizedDescription.includes(keyword))) {
      return Number(Math.abs(parsedAmount).toFixed(2));
    }
    if (EXPENSE_KEYWORDS.some((keyword) => normalizedDescription.includes(keyword))) {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }

    if (accountType === AccountType.Credit) {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }

    if (accountType === AccountType.Checking || accountType === AccountType.Savings) {
      return Number((-Math.abs(parsedAmount)).toFixed(2));
    }

    return Number(parsedAmount.toFixed(2));
  }

  private parseAmountValue(rawAmount: string): number | undefined {
    const cleaned = rawAmount
      .replace(/\$/g, '')
      .replace(/,/g, '')
      .replace(/[()]/g, '')
      .trim();

    if (!cleaned) {
      return undefined;
    }

    const numeric = Number.parseFloat(cleaned);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }

    return numeric;
  }

  private normalizeDescription(descriptionRaw: string): string {
    return descriptionRaw
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseDateToken(token: string, referenceDate: Date): Date | undefined {
    const trimmed = token.trim().replace(',', '');
    if (!trimmed) {
      return undefined;
    }

    if (/[A-Za-z]/.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        return undefined;
      }
      return this.startOfDayUtc(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
    }

    const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
    if (!match) {
      return undefined;
    }

    const month = Number.parseInt(match[1], 10);
    const day = Number.parseInt(match[2], 10);
    const yearToken = match[3];
    let year = referenceDate.getUTCFullYear();

    if (yearToken) {
      year = Number.parseInt(yearToken, 10);
      if (yearToken.length === 2) {
        year += year >= 70 ? 1900 : 2000;
      }
    } else {
      const referenceMonth = referenceDate.getUTCMonth() + 1;
      if (month - referenceMonth >= 2) {
        year -= 1;
      } else if (referenceMonth - month >= 10) {
        year += 1;
      }
    }

    return this.startOfDayUtc(year, month, day);
  }

  private startOfDayUtc(year: number, month: number, day: number): Date | undefined {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() + 1 !== month
      || candidate.getUTCDate() !== day
    ) {
      return undefined;
    }

    return candidate;
  }

  private toIsoDay(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private buildTotals(transactions: ParsedTransactionDraft[]): StatementTotalsDraft {
    let totalDebits = 0;
    let totalCredits = 0;

    for (const transaction of transactions) {
      if (transaction.amount < 0) {
        totalDebits += Math.abs(transaction.amount);
      } else if (transaction.amount > 0) {
        totalCredits += transaction.amount;
      }
    }

    return {
      ...(totalDebits > 0 ? { totalDebits: Number(totalDebits.toFixed(2)) } : {}),
      ...(totalCredits > 0 ? { totalCredits: Number(totalCredits.toFixed(2)) } : {}),
    };
  }

  private buildConfidence(params: {
    textLength: number;
    transactionCount: number;
    hasStatementPeriod: boolean;
    hasBalances: boolean;
    hasCreditDetails: boolean;
  }): StatementConfidenceDraft {
    const notes: string[] = [];
    let score = 0;

    if (params.textLength > 40) {
      score += 0.2;
    } else {
      notes.push('Very little text was extracted from the PDF.');
    }

    if (params.transactionCount > 0) {
      score += 0.4;
      if (params.transactionCount < 3) {
        notes.push('Only a small number of transactions were detected.');
      }
    } else {
      notes.push('No transaction rows were detected.');
    }

    if (params.hasStatementPeriod) {
      score += 0.15;
    } else {
      notes.push('Could not detect statement period.');
    }

    if (params.hasBalances) {
      score += 0.15;
    } else {
      notes.push('Could not detect opening/closing balance lines.');
    }

    if (params.hasCreditDetails) {
      score += 0.1;
    }

    const overall = Math.max(0, Math.min(1, Number(score.toFixed(2))));
    return { overall, notes };
  }

  private async ensurePdfParseRuntimePolyfills(): Promise<void> {
    if (this.pdfParsePolyfillsInitialized) {
      return;
    }

    this.pdfParsePolyfillsInitialized = true;
    const runtime = globalThis as Record<string, unknown>;
    if (runtime.DOMMatrix && runtime.ImageData && runtime.Path2D) {
      return;
    }

    try {
      // pdf-parse/pdfjs expects these globals in some Node runtimes.
      const canvas = require('@napi-rs/canvas') as {
        DOMMatrix?: unknown;
        ImageData?: unknown;
        Path2D?: unknown;
      };
      if (!runtime.DOMMatrix && canvas.DOMMatrix) {
        runtime.DOMMatrix = canvas.DOMMatrix;
      }
      if (!runtime.ImageData && canvas.ImageData) {
        runtime.ImageData = canvas.ImageData;
      }
      if (!runtime.Path2D && canvas.Path2D) {
        runtime.Path2D = canvas.Path2D;
      }
    } catch {
      // Continue with best-effort parse behavior.
    }
  }
}
