import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ParsedStatementDocument = HydratedDocument<ParsedStatement>;

export enum ParsedStatementStatus {
  Pending = 'pending',
  Processing = 'processing',
  Parsed = 'parsed',
  Failed = 'failed',
  NeedsReview = 'needs_review',
}

@Schema({ _id: false })
export class ParsedStatementMeta {
  @Prop({ trim: true })
  institutionName?: string;

  @Prop({ trim: true })
  accountLast4?: string;

  @Prop()
  statementPeriodStart?: Date;

  @Prop()
  statementPeriodEnd?: Date;

  @Prop({
    required: true,
    enum: ['USD'],
    default: 'USD',
  })
  currency: 'USD';

  @Prop()
  openingBalance?: number;

  @Prop()
  closingBalance?: number;

  @Prop()
  minPayment?: number;

  @Prop()
  interestCharged?: number;

  @Prop()
  feesCharged?: number;

  @Prop()
  apr?: number;
}

@Schema({ _id: false })
export class ParsedStatementTotals {
  @Prop()
  totalDebits?: number;

  @Prop()
  totalCredits?: number;
}

@Schema({ _id: false })
export class ParsedStatementConfidence {
  @Prop({
    required: true,
    min: 0,
    max: 1,
    default: 0,
  })
  overall: number;

  @Prop({
    type: [String],
    default: [],
  })
  notes: string[];
}

@Schema({ collection: 'parsed_statements', timestamps: true })
export class ParsedStatement {
  @Prop({ required: true, trim: true, index: true })
  sessionId: string;

  @Prop({ required: true, trim: true, index: true })
  fileId: string;

  @Prop({
    required: true,
    enum: ParsedStatementStatus,
    default: ParsedStatementStatus.Pending,
  })
  status: ParsedStatementStatus;

  @Prop({
    required: true,
    trim: true,
    default: 'v1',
  })
  parserVersion: string;

  @Prop()
  extractedAt?: Date;

  @Prop({
    type: ParsedStatementMeta,
    default: () => ({ currency: 'USD' }),
  })
  statementMeta: ParsedStatementMeta;

  @Prop({
    type: ParsedStatementTotals,
    default: () => ({}),
  })
  totals: ParsedStatementTotals;

  @Prop({
    type: ParsedStatementConfidence,
    default: () => ({ overall: 0, notes: [] }),
  })
  confidence: ParsedStatementConfidence;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ParsedStatementSchema = SchemaFactory.createForClass(ParsedStatement);
ParsedStatementSchema.index({ fileId: 1 }, { unique: true });
ParsedStatementSchema.index({ sessionId: 1, status: 1 });
