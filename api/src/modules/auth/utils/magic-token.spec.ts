import { generateMagicToken, hashMagicToken, MAGIC_TOKEN_BYTES } from './magic-token';

describe('magic-token utils', () => {
  it('generates token from random bytes with expected hex length', () => {
    const token = generateMagicToken();
    expect(token).toHaveLength(MAGIC_TOKEN_BYTES * 2);
    expect(token).toMatch(/^[a-f0-9]+$/);
  });

  it('hashes token deterministically with sha256 hex output', () => {
    const token = 'sample-token';
    const hashA = hashMagicToken(token);
    const hashB = hashMagicToken(token);

    expect(hashA).toEqual(hashB);
    expect(hashA).toHaveLength(64);
    expect(hashA).toMatch(/^[a-f0-9]+$/);
  });
});
