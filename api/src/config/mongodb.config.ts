const DEFAULT_DB_HOST = 'cluster0.fgs8h.mongodb.net';
const DEFAULT_DB_APP_NAME = 'Cluster0';

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");

  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function getRequiredEnv(name: 'DB_USER' | 'DB_PASS'): string {
  const value = normalizeEnv(process.env[name]);
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export function getMongoUri(): string {
  const explicitUri = normalizeEnv(process.env.MONGODB_URI);
  if (explicitUri) {
    return explicitUri;
  }

  const username = getRequiredEnv('DB_USER');
  const password = getRequiredEnv('DB_PASS');
  const host = normalizeEnv(process.env.DB_HOST) ?? DEFAULT_DB_HOST;
  const appName = normalizeEnv(process.env.DB_APP_NAME) ?? DEFAULT_DB_APP_NAME;
  const dbName = normalizeEnv(process.env.DB_NAME);

  if (!host) {
    throw new Error('DB_HOST is not set');
  }

  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  const dbPath = dbName ? `/${encodeURIComponent(dbName)}` : '/';
  const appNameQuery = `appName=${encodeURIComponent(appName)}`;

  return `mongodb+srv://${encodedUser}:${encodedPass}@${host}${dbPath}?${appNameQuery}`;
}
