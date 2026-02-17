import { getConnectionToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_S3_BUCKET = 'balance-statements';

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

function getRequiredEnv(name: string): string {
  const value = normalizeEnv(process.env[name]);
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

function getAwsRegion(): string {
  const region = normalizeEnv(process.env.AWS_REGION);
  if (region) {
    return region;
  }

  console.warn('AWS_REGION is not set. Defaulting to us-east-1');
  return 'us-east-1';
}

async function verifyS3Connection(): Promise<void> {
  const accessKeyId = getRequiredEnv('AWS_ACCESS_KEY_ID');
  const secretAccessKey = getRequiredEnv('AWS_SECRET_ACCESS_KEY');
  const bucket = normalizeEnv(process.env.S3_BUCKET_NAME) ?? DEFAULT_S3_BUCKET;
  const region = getAwsRegion();

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

function registerDbConnectedLog(app: INestApplication): void {
  const connection = app.get<Connection>(getConnectionToken());

  if (connection.readyState === 1) {
    console.log('Connected to DB');
  } else {
    connection.once('connected', () => {
      console.log('Connected to DB');
    });
  }
}

export function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = normalizeEnv(line.slice(separatorIndex + 1)) ?? '';
  }
}

export async function initializeStartupConnections(app: INestApplication): Promise<void> {
  registerDbConnectedLog(app);
  await verifyS3Connection();
  console.log('Connected to S3');
}
