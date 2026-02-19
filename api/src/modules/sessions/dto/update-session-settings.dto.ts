import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

export class UpdateSessionSettingsDto {
  @Transform(({ value }) => {
    if (value === true || value === false) {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
    return value;
  })
  @IsBoolean()
  autoCategorizeOnUpload: boolean;
}
