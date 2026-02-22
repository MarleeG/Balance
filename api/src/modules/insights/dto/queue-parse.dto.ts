import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class QueueParseDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  fileIds: string[];
}
