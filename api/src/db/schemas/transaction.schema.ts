import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AccountType } from './file.schema';

export type TransactionDocument = HydratedDocument<TransactionRecord>;

@Schema({
  collection: 'transactions',
  timestamps: {
    createdAt: true,
    updatedAt: false,
  },
})
export class TransactionRecord {
  @Prop({ required: true, trim: true, index: true })
  sessionId: string;

  @Prop({ required: true, trim: true, index: true })
  fileId: string;

  @Prop({
    required: true,
    enum: AccountType,
    index: true,
  })
  accountType: AccountType;

  @Prop({ required: true, index: true })
  txnDate: Date;

  @Prop()
  postDate?: Date;

  @Prop({ required: true, trim: true })
  descriptionRaw: string;

  @Prop({ required: true, trim: true, index: true })
  descriptionNormalized: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ trim: true })
  categoryHint?: string;

  @Prop({ trim: true })
  merchantHint?: string;

  @Prop({ required: true, trim: true })
  hash: string;

  createdAt?: Date;
}

export const TransactionSchema = SchemaFactory.createForClass(TransactionRecord);
TransactionSchema.index({ hash: 1 }, { unique: true });
TransactionSchema.index({ sessionId: 1, fileId: 1, txnDate: -1 });
TransactionSchema.index({ sessionId: 1, descriptionNormalized: 1 });
