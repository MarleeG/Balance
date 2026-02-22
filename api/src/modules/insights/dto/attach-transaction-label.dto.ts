import { IsString, MaxLength, MinLength } from 'class-validator';

export class AttachTransactionLabelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  labelId: string;
}
