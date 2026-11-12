import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { assertKey, type FileStore } from './store.js';

export interface S3StoreOptions {
  bucket: string;
  region: string;
  /** Set for MinIO or any other S3-compatible service; left out for AWS itself. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Left out to use the environment's role (instance or task role). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Asks the service to encrypt each object; the bucket's own default applies when left out. */
  serverSideEncryption?: ServerSideEncryption;
}

/**
 * Files in a bucket of an S3-compatible service. Objects are never public: they are read and
 * written by the API only, which serves them through its own signed links (`signing.ts`), so the
 * size and type limits and the hospital checks stay in one place. Keys carry the hospital's id
 * as their first part, as with the local store.
 */
export class S3FileStore implements FileStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3StoreOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ServerSideEncryption: this.options.serverSideEncryption,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  close(): void {
    this.client.destroy();
  }
}
