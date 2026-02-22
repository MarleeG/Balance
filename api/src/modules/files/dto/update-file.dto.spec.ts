import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateFileDto } from './update-file.dto';

describe('UpdateFileDto', () => {
  it('accepts displayName within 1..80 characters', () => {
    const dto = plainToInstance(UpdateFileDto, { displayName: 'Statement (Feb 2026)' });
    const errors = validateSync(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects displayName shorter than 1 character', () => {
    const dto = plainToInstance(UpdateFileDto, { displayName: '' });
    const errors = validateSync(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints?.minLength).toBe('Display name must be at least 1 character.');
  });

  it('rejects displayName longer than 80 characters', () => {
    const dto = plainToInstance(UpdateFileDto, { displayName: 'a'.repeat(81) });
    const errors = validateSync(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints?.maxLength).toBe('Display name must be 80 characters or fewer.');
  });

  it('rejects non-string displayName', () => {
    const dto = plainToInstance(UpdateFileDto, { displayName: 12345 });
    const errors = validateSync(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints?.isString).toBe('Display name must be a string.');
  });
});
