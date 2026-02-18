import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UploadObjectParams {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
}

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith('\'') && trimmed.endsWith('\'');

  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client | null = null;

  constructor(private readonly configService: ConfigService) {}

  async uploadObject({ bucket, key, body, contentType }: UploadObjectParams): Promise<void> {
    await this.getS3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.getS3Client().send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
  }

  private getS3Client(): S3Client {
    if (this.s3Client) {
      return this.s3Client;
    }

    const region = this.getRequiredEnv('AWS_REGION');
    const accessKeyId = this.getRequiredEnv('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.getRequiredEnv('AWS_SECRET_ACCESS_KEY');
    const endpoint = this.getOptionalEnv('AWS_S3_ENDPOINT') ?? this.getOptionalEnv('S3_ENDPOINT');
    const forcePathStyle = this.getOptionalEnv('AWS_S3_FORCE_PATH_STYLE') === 'true';

    this.s3Client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      followRegionRedirects: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    if (endpoint) {
      this.logger.log(`Using custom S3 endpoint: ${endpoint}`);
    }

    return this.s3Client;
  }

  private getRequiredEnv(name: string): string {
    const value = normalizeEnv(this.configService.get<string>(name));
    if (!value) {
      throw new InternalServerErrorException(`${name} must be configured.`);
    }

    return value;
  }

  private getOptionalEnv(name: string): string | undefined {
    return normalizeEnv(this.configService.get<string>(name));
  }
}
