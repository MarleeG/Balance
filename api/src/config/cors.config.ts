function normalizeEnvValue(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
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

function parseOriginFromUrl(url: string): string {
  if (!url) {
    return '';
  }

  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function getCorsOrigins(): string[] {
  const configured = normalizeEnvValue(process.env.CORS_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const appPublicOrigin = parseOriginFromUrl(normalizeEnvValue(process.env.APP_PUBLIC_URL));
  const defaults = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ];

  return [...new Set([...defaults, appPublicOrigin, ...configured])];
}
