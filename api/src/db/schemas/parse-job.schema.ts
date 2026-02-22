import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ParseJobDocument = HydratedDocument<ParseJob>;

export enum ParseJobStatus {
  Pending = 'pending',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
}

@Schema({ collection: 'parse_jobs', timestamps: true })
export class ParseJob {
  @Prop({ required: true, trim: true, index: true })
  sessionId: string;

  @Prop({ required: true, trim: true, index: true })
  fileId: string;

  @Prop({
    required: true,
    enum: ParseJobStatus,
    default: ParseJobStatus.Pending,
  })
  status: ParseJobStatus;

  @Prop({ required: true, min: 0, default: 0 })
  attempts: number;

  @Prop({ required: true, min: 1, default: 5 })
  maxAttempts: number;

  @Prop({ default: 0 })
  priority: number;

  @Prop({ required: true, default: () => new Date() })
  nextRunAt: Date;

  @Prop()
  lockedBy?: string;

  @Prop()
  leaseExpiresAt?: Date;

  @Prop()
  startedAt?: Date;

  @Prop()
  completedAt?: Date;

  @Prop()
  lastError?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ParseJobSchema = SchemaFactory.createForClass(ParseJob);
ParseJobSchema.index({ sessionId: 1, fileId: 1 }, { unique: true });
ParseJobSchema.index({ status: 1, nextRunAt: 1, leaseExpiresAt: 1 });
