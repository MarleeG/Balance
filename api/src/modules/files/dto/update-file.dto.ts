import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StatementType } from '../../../db/schemas/file.schema';

export class UpdateFileDto {
  @IsOptional()
  @IsEnum(StatementType)
  statementType?: StatementType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalName?: string;

  @IsOptional()
  @IsString({ message: 'Display name must be a string.' })
  @MinLength(1, { message: 'Display name must be at least 1 character.' })
  @MaxLength(80, { message: 'Display name must be 80 characters or fewer.' })
  displayName?: string;
}
