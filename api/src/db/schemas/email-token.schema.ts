import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmailTokenDocument = HydratedDocument<EmailToken>;

export enum EmailTokenPurpose {
  ContinueSession = 'continue_session',
  FindSessions = 'find_sessions',
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

@Schema({ collection: 'email_tokens' })
export class EmailToken {
  @Prop({ required: true, trim: true })
  tokenHash: string;

  @Prop({
    required: true,
    lowercase: true,
    trim: true,
  })
  email: string;

  @Prop({ trim: true })
  sessionId?: string;

  @Prop({
    required: true,
    enum: EmailTokenPurpose,
  })
  purpose: EmailTokenPurpose;

  @Prop({
    required: true,
    default: () => new Date(Date.now() + FIFTEEN_MINUTES_MS),
  })
  expiresAt: Date;

  @Prop()
  usedAt?: Date;

  @Prop({ default: () => new Date() })
  createdAt: Date;

  @Prop({ trim: true })
  ip?: string;

  @Prop({ trim: true })
  userAgent?: string;
}

export const EmailTokenSchema = SchemaFactory.createForClass(EmailToken);
EmailTokenSchema.index({ tokenHash: 1 }, { unique: true });
EmailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
EmailTokenSchema.index({ email: 1 });
