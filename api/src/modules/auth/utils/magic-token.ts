import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../../common/utils/hash.util';

export const MAGIC_TOKEN_BYTES = 32;

export function generateMagicToken(bytes = MAGIC_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('hex');
}

export function hashMagicToken(token: string): string {
  return sha256Hex(token);
}
