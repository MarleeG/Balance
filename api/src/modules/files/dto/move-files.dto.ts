import { ArrayNotEmpty, IsArray, IsIn, IsMongoId } from 'class-validator';
import { FileCategory } from '../../../db/schemas/file.schema';

export class MoveFilesToCategoryDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsMongoId({ each: true })
  fileIds: string[];

  @IsIn([
    FileCategory.Credit,
    FileCategory.Checking,
    FileCategory.Savings,
    FileCategory.Unknown,
    FileCategory.Unfiled,
  ])
  category: FileCategory;
}
