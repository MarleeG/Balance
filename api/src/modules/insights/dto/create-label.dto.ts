import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LabelType } from '../../../db/schemas/label.schema';

export class CreateLabelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsEnum(LabelType)
  type?: LabelType;

  @IsBoolean()
  isIncome: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}
