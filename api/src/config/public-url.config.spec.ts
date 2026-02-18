import {
  buildClientPublicUrl,
  buildPublicUrl,
  getSanitizedApiPublicUrl,
  getSanitizedAppPublicUrl,
} from './public-url.config';

describe('buildPublicUrl', () => {
  const originalAppPublicUrl = process.env.APP_PUBLIC_URL;
  const originalClientPublicUrl = process.env.CLIENT_PUBLIC_URL;
  const originalApiPublicUrl = process.env.API_PUBLIC_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalAppPublicUrl === undefined) {
      delete process.env.APP_PUBLIC_URL;
    } else {
      process.env.APP_PUBLIC_URL = originalAppPublicUrl;
    }

    if (originalClientPublicUrl === undefined) {
      delete process.env.CLIENT_PUBLIC_URL;
    } else {
      process.env.CLIENT_PUBLIC_URL = originalClientPublicUrl;
    }

    if (originalApiPublicUrl === undefined) {
      delete process.env.API_PUBLIC_URL;
    } else {
      process.env.API_PUBLIC_URL = originalApiPublicUrl;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
      return;
    }

    process.env.NODE_ENV = originalNodeEnv;
  });

  it('builds URL from quoted host and prefixes https when scheme is missing', () => {
    process.env.CLIENT_PUBLIC_URL = '"balance-2bbjqq.fly.dev"';

    const url = buildPublicUrl('/auth/verify', { token: 'abc123' });

    expect(url).toBe('https://balance-2bbjqq.fly.dev/auth/verify?token=abc123');
  });

  it('removes trailing slash and joins path safely', () => {
    process.env.CLIENT_PUBLIC_URL = 'https://balance-2bbjqq.fly.dev/';

    const url = buildPublicUrl('auth/verify', { token: 'def456' });

    expect(url).toBe('https://balance-2bbjqq.fly.dev/auth/verify?token=def456');
  });

  it('supports single-quoted base URL values', () => {
    process.env.CLIENT_PUBLIC_URL = "'https://balance-2bbjqq.fly.dev'";

    const url = buildPublicUrl('/auth/verify', { token: 'ghi789' });

    expect(url).toBe('https://balance-2bbjqq.fly.dev/auth/verify?token=ghi789');
  });

  it('falls back to localhost only in local-like environments', () => {
    delete process.env.APP_PUBLIC_URL;
    delete process.env.CLIENT_PUBLIC_URL;
    process.env.NODE_ENV = 'local';

    const url = buildPublicUrl('/auth/verify', { token: 'local123' });

    expect(url).toBe('http://localhost:4173/auth/verify?token=local123');
  });

  it('throws when APP_PUBLIC_URL is missing in production-like environments', () => {
    delete process.env.APP_PUBLIC_URL;
    delete process.env.CLIENT_PUBLIC_URL;
    process.env.NODE_ENV = 'production';

    expect(() => getSanitizedAppPublicUrl()).toThrow('CLIENT_PUBLIC_URL must be set for non-local environments.');
  });

  it('supports explicit API public URL with quoted value and missing scheme', () => {
    process.env.API_PUBLIC_URL = '"api.balance-2bbjqq.fly.dev"';

    expect(getSanitizedApiPublicUrl()).toBe('https://api.balance-2bbjqq.fly.dev');
  });

  it('buildClientPublicUrl uses CLIENT_PUBLIC_URL over APP_PUBLIC_URL', () => {
    process.env.CLIENT_PUBLIC_URL = 'https://balance-2bbjqq.fly.dev';
    process.env.APP_PUBLIC_URL = 'https://old-app-public-url.example.com';

    const url = buildClientPublicUrl('/auth/verify', { token: 'xyz123' });

    expect(url).toBe('https://balance-2bbjqq.fly.dev/auth/verify?token=xyz123');
  });
});
