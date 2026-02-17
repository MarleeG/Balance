import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class RequestLinkDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsEmail()
  email: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Length(8, 8)
  @Matches(/^[A-Za-z0-9]+$/)
  sessionId: string;
}
