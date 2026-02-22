import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LabelRuleDocument = HydratedDocument<LabelRule>;

export enum LabelRuleDirection {
  In = 'in',
  Out = 'out',
}

export enum LabelRuleAccountType {
  Credit = 'credit',
  Checking = 'checking',
  Savings = 'savings',
  Any = 'any',
}

export enum LabelRuleApplyMode {
  Auto = 'auto',
  Suggest = 'suggest',
}

@Schema({ _id: false })
export class LabelRuleMatch {
  @Prop({
    type: [String],
    default: [],
  })
  descriptionContains?: string[];

  @Prop({ trim: true })
  descriptionRegex?: string;

  @Prop({ trim: true })
  merchant?: string;

  @Prop()
  amountEquals?: number;

  @Prop()
  amountMin?: number;

  @Prop()
  amountMax?: number;

  @Prop({
    enum: LabelRuleDirection,
  })
  direction?: LabelRuleDirection;

  @Prop({
    enum: LabelRuleAccountType,
    default: LabelRuleAccountType.Any,
  })
  accountType?: LabelRuleAccountType;
}

@Schema({ collection: 'label_rules', timestamps: true })
export class LabelRule {
  @Prop({
    required: true,
    lowercase: true,
    trim: true,
    index: true,
  })
  ownerEmail: string;

  @Prop({ required: true, trim: true, index: true })
  labelId: string;

  @Prop({
    type: LabelRuleMatch,
    default: () => ({ accountType: LabelRuleAccountType.Any }),
  })
  match: LabelRuleMatch;

  @Prop({
    required: true,
    enum: LabelRuleApplyMode,
    default: LabelRuleApplyMode.Suggest,
  })
  applyMode: LabelRuleApplyMode;

  createdAt?: Date;
  updatedAt?: Date;
}

export const LabelRuleSchema = SchemaFactory.createForClass(LabelRule);
LabelRuleSchema.index({ ownerEmail: 1, labelId: 1 });
