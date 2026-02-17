import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StatementType } from '../../../db/schemas/file.schema';
import { UploadFileMetaDto } from '../dto/upload-file-meta.dto';

const META_PARSE_ERROR_MESSAGE = 'meta must be a JSON array of { clientFileName, statementType? }.';

@Injectable()
export class ParseUploadMetaPipe implements PipeTransform {
  transform(value: unknown): Map<string, StatementType> {
    if (value === undefined || value === null || value === '') {
      return new Map();
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(META_PARSE_ERROR_MESSAGE);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException(META_PARSE_ERROR_MESSAGE);
    }

    if (!Array.isArray(parsed)) {
      throw new BadRequestException(META_PARSE_ERROR_MESSAGE);
    }

    const map = new Map<string, StatementType>();

    for (const entry of parsed) {
      const dto = plainToInstance(UploadFileMetaDto, entry);
      const errors = validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      if (errors.length > 0) {
        throw new BadRequestException(META_PARSE_ERROR_MESSAGE);
      }

      const fileName = dto.clientFileName.trim();
      if (!fileName) {
        throw new BadRequestException(META_PARSE_ERROR_MESSAGE);
      }

      map.set(fileName, dto.statementType ?? StatementType.Unknown);
    }

    return map;
  }
}
