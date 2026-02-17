import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';

export class CreateSessionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsEmail()
  email: string;
}
