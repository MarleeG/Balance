import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TransactionLabelDocument = HydratedDocument<TransactionLabel>;

@Schema({
  collection: 'transaction_labels',
  timestamps: {
    createdAt: true,
    updatedAt: false,
  },
})
export class TransactionLabel {
  @Prop({ required: true, trim: true, index: true })
  sessionId: string;

  @Prop({ required: true, trim: true, index: true })
  transactionId: string;

  @Prop({ required: true, trim: true, index: true })
  labelId: string;

  createdAt?: Date;
}

export const TransactionLabelSchema = SchemaFactory.createForClass(TransactionLabel);
TransactionLabelSchema.index({ transactionId: 1, labelId: 1 }, { unique: true });
TransactionLabelSchema.index({ sessionId: 1, labelId: 1 });
