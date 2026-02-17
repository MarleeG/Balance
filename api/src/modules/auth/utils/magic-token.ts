import { createHash, randomBytes } from 'node:crypto';

export const MAGIC_TOKEN_BYTES = 32;

export function generateMagicToken(bytes = MAGIC_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('hex');
}

export function hashMagicToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
