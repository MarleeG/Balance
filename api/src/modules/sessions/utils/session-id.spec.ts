import { SESSION_ID_CHARSET, SESSION_ID_LENGTH, generateSessionId } from './session-id';

describe('generateSessionId', () => {
  it('creates IDs with expected length and charset', () => {
    for (let i = 0; i < 100; i += 1) {
      const sessionId = generateSessionId();

      expect(sessionId).toHaveLength(SESSION_ID_LENGTH);
      expect(sessionId).not.toMatch(/[0O1Il]/);
      expect(sessionId).toMatch(new RegExp(`^[${SESSION_ID_CHARSET}]{${SESSION_ID_LENGTH}}$`));
    }
  });
});
