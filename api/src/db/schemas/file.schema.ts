import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FileDocument = HydratedDocument<FileRecord>;

export enum StatementType {
  Credit = 'credit',
  Checking = 'checking',
  Savings = 'savings',
  Unknown = 'unknown',
}

export enum FileStatus {
  Pending = 'pending',
  Uploaded = 'uploaded',
  Deleted = 'deleted',
  Rejected = 'rejected',
}

@Schema({ collection: 'files', timestamps: true })
export class FileRecord {
  @Prop({ required: true, trim: true })
  sessionId: string;

  @Prop({ required: true, trim: true })
  originalName: string;

  @Prop({ required: true, trim: true })
  mimeType: string;

  @Prop({ required: true, min: 1 })
  size: number;

  @Prop({
    enum: StatementType,
    default: StatementType.Unknown,
  })
  statementType: StatementType;

  @Prop({
    enum: StatementType,
    default: StatementType.Unknown,
  })
  autoDetectedType: StatementType;

  @Prop({
    min: 0,
    max: 1,
    default: 0,
  })
  detectionConfidence: number;

  @Prop({
    default: false,
  })
  isLikelyStatement: boolean;

  @Prop({
    default: false,
  })
  confirmedByUser: boolean;

  @Prop({
    enum: FileStatus,
    default: FileStatus.Pending,
  })
  status: FileStatus;

  @Prop({ required: true, trim: true })
  s3Bucket: string;

  @Prop({ required: true, trim: true })
  s3Key: string;

  @Prop({ default: () => new Date() })
  uploadedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const FileSchema = SchemaFactory.createForClass(FileRecord);
FileSchema.index({ sessionId: 1 });
FileSchema.index({ sessionId: 1, uploadedAt: -1 });
