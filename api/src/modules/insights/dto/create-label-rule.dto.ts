import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  LabelRuleAccountType,
  LabelRuleApplyMode,
  LabelRuleDirection,
} from '../../../db/schemas/label-rule.schema';

export class CreateLabelRuleMatchDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  descriptionContains?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  descriptionRegex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsOptional()
  @IsNumber()
  amountEquals?: number;

  @IsOptional()
  @IsNumber()
  amountMin?: number;

  @IsOptional()
  @IsNumber()
  amountMax?: number;

  @IsOptional()
  @IsEnum(LabelRuleDirection)
  direction?: LabelRuleDirection;

  @IsOptional()
  @IsEnum(LabelRuleAccountType)
  accountType?: LabelRuleAccountType;
}

export class CreateLabelRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  labelId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateLabelRuleMatchDto)
  match?: CreateLabelRuleMatchDto;

  @IsOptional()
  @IsEnum(LabelRuleApplyMode)
  applyMode?: LabelRuleApplyMode;
}
