import { IsEnum } from 'class-validator';
import { StatementType } from '../../../db/schemas/file.schema';

export class UpdateFileDto {
  @IsEnum(StatementType)
  statementType: StatementType;
}
