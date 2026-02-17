import { randomInt } from 'node:crypto';

export const SESSION_ID_LENGTH = 8;
export const SESSION_ID_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateSessionId(length = SESSION_ID_LENGTH): string {
  return Array.from({ length }, () => SESSION_ID_CHARSET[randomInt(SESSION_ID_CHARSET.length)]).join('');
}
