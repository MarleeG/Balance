import { IsIn, IsInt } from 'class-validator';

export class ExtendSessionDto {
  @IsInt()
  @IsIn([1, 3, 7])
  days: 1 | 3 | 7;
}
