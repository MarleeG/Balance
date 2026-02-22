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

export enum FileCategory {
  Credit = 'credit',
  Checking = 'checking',
  Savings = 'savings',
  Unknown = 'unknown',
  Unfiled = 'unfiled',
}

export enum AccountType {
  Credit = 'credit',
  Checking = 'checking',
  Savings = 'savings',
}

@Schema({ collection: 'files', timestamps: true })
export class FileRecord {
  @Prop({ required: true, trim: true })
  sessionId: string;

  @Prop({ trim: true })
  fileId?: string;

  @Prop({ required: true, trim: true })
  originalName: string;

  @Prop({ trim: true, maxlength: 80 })
  displayName?: string;

  @Prop({ required: true, trim: true })
  mimeType: string;

  @Prop({ required: true, min: 1 })
  byteSize: number;

  // Legacy field kept for migration compatibility with older records.
  @Prop({ min: 1 })
  size?: number;

  @Prop({
    enum: AccountType,
  })
  accountType?: AccountType;

  @Prop({
    enum: StatementType,
    default: StatementType.Unknown,
  })
  statementType: StatementType;

  @Prop({
    enum: FileCategory,
    default: FileCategory.Unfiled,
  })
  category: FileCategory;

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

  createdAt?: Date;
  updatedAt?: Date;
}

export const FileSchema = SchemaFactory.createForClass(FileRecord);
FileSchema.pre('validate', function setFileId() {
  const doc = this as FileDocument;
  if (!doc.fileId && doc._id) {
    doc.fileId = doc._id.toString();
  }
});
FileSchema.index({ sessionId: 1 });
FileSchema.index({ fileId: 1 }, { unique: true, sparse: true });
FileSchema.index({ sessionId: 1, uploadedAt: -1 });
FileSchema.index({ sessionId: 1, category: 1, uploadedAt: -1 });
