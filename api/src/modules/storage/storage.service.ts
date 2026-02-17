import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
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
  private readonly s3Client: S3Client;

  constructor(private readonly configService: ConfigService) {
    const region = this.getRequiredEnv('AWS_REGION');
    const accessKeyId = this.getRequiredEnv('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.getRequiredEnv('AWS_SECRET_ACCESS_KEY');

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async uploadObject({ bucket, key, body, contentType }: UploadObjectParams): Promise<void> {
    await this.s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.s3Client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
  }

  private getRequiredEnv(name: string): string {
    const value = normalizeEnv(this.configService.get<string>(name));
    if (!value) {
      throw new InternalServerErrorException(`${name} must be configured.`);
    }

    return value;
  }
}
