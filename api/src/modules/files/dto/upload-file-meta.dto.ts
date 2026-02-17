import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { StatementType } from '../../../db/schemas/file.schema';

export class UploadFileMetaDto {
  @IsString()
  @MinLength(1)
  clientFileName: string;

  @IsOptional()
  @IsEnum(StatementType)
  statementType?: StatementType;
}
