import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LabelDocument = HydratedDocument<Label>;

export enum LabelType {
  Custom = 'custom',
  System = 'system',
}

@Schema({
  collection: 'labels',
  timestamps: {
    createdAt: true,
    updatedAt: false,
  },
})
export class Label {
  @Prop({
    required: true,
    lowercase: true,
    trim: true,
    index: true,
  })
  ownerEmail: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 80,
  })
  name: string;

  @Prop({
    required: true,
    enum: LabelType,
    default: LabelType.Custom,
  })
  type: LabelType;

  @Prop({
    required: true,
    default: false,
  })
  isIncome: boolean;

  @Prop({ trim: true })
  color?: string;

  createdAt?: Date;
}

export const LabelSchema = SchemaFactory.createForClass(Label);
LabelSchema.index({ ownerEmail: 1, type: 1 });
LabelSchema.index({ ownerEmail: 1, name: 1 });
