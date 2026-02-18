const DEFAULT_LOCAL_CLIENT_PUBLIC_URL = 'http://localhost:4173';
const DEFAULT_LOCAL_API_PUBLIC_URL = 'http://localhost:3000';

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  return `/${trimmed.replace(/^\/+/, '')}`;
}

function normalizeBasePublicUrl(rawValue: string): string {
  const raw = stripWrappingQuotes(rawValue);
  const base = raw || DEFAULT_LOCAL_CLIENT_PUBLIC_URL;
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return withScheme.replace(/\/+$/, '');
}

function isLocalLikeEnv(nodeEnvRaw: string | undefined): boolean {
  const nodeEnv = stripWrappingQuotes(nodeEnvRaw ?? '').toLowerCase();
  return nodeEnv === 'local' || nodeEnv === 'dev' || nodeEnv === 'development' || nodeEnv === 'test';
}

export function getSanitizedAppPublicUrl(): string {
  const configured = stripWrappingQuotes(process.env.CLIENT_PUBLIC_URL ?? process.env.APP_PUBLIC_URL ?? '');
  if (configured) {
    return normalizeBasePublicUrl(configured);
  }

  if (isLocalLikeEnv(process.env.NODE_ENV)) {
    return DEFAULT_LOCAL_CLIENT_PUBLIC_URL;
  }

  throw new Error('CLIENT_PUBLIC_URL must be set for non-local environments.');
}

export function getSanitizedClientPublicUrl(): string {
  return getSanitizedAppPublicUrl();
}

export function getSanitizedApiPublicUrl(): string {
  const configured = stripWrappingQuotes(process.env.API_PUBLIC_URL ?? '');
  if (configured) {
    return normalizeBasePublicUrl(configured);
  }

  if (isLocalLikeEnv(process.env.NODE_ENV)) {
    return DEFAULT_LOCAL_API_PUBLIC_URL;
  }

  throw new Error('API_PUBLIC_URL must be set for non-local environments.');
}

export function buildPublicUrl(path: string, params: Record<string, string> = {}): string {
  const baseUrl = getSanitizedClientPublicUrl();
  const url = new URL(`${baseUrl}${normalizePath(path)}`);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

export function buildClientPublicUrl(path: string, params: Record<string, string> = {}): string {
  const baseUrl = getSanitizedClientPublicUrl();
  const url = new URL(`${baseUrl}${normalizePath(path)}`);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}
