import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListTransactionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  fileId?: string;
}
