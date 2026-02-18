import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

export enum SessionStatus {
  Active = 'active',
  Expired = 'expired',
  Deleted = 'deleted',
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9]{8}$/;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

@Schema({ collection: 'sessions', timestamps: true })
export class Session {
  @Prop({
    required: true,
    trim: true,
    match: SESSION_ID_PATTERN,
  })
  sessionId: string;

  @Prop({
    required: true,
    lowercase: true,
    trim: true,
  })
  email: string;

  @Prop({
    enum: SessionStatus,
    default: SessionStatus.Active,
  })
  status: SessionStatus;

  @Prop({
    required: true,
    default: () => new Date(Date.now() + ONE_WEEK_MS),
  })
  expiresAt: Date;

  @Prop()
  lastAccessedAt?: Date;

  @Prop()
  deletedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ sessionId: 1 }, { unique: true });
SessionSchema.index({ email: 1 });
