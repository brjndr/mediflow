import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
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
 * Files in a bucket of an S3-compatible service. Objects are never public. The API reads and
 * writes them, and hands the browser a presigned address only after its own checks (hospital,
 * permission, scan status, announced size and type). Keys carry the hospital's id as their first
 * part, as with the local store.
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

  async presign(
    key: string,
    ttlSeconds: number,
    options: { fileName?: string; contentType?: string } = {},
  ): Promise<string> {
    assertKey(key);
    const safeName = options.fileName?.replace(/[^A-Za-z0-9._ -]/g, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: safeName ? `attachment; filename="${safeName}"` : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async presignUpload(
    key: string,
    options: { contentType: string; size: number; ttlSeconds: number },
  ): Promise<string> {
    assertKey(key);
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.size,
        ServerSideEncryption: this.options.serverSideEncryption,
      }),
      {
        expiresIn: options.ttlSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  async size(key: string): Promise<number | null> {
    assertKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return result.ContentLength ?? null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw error;
    }
  }

  close(): void {
    this.client.destroy();
  }
}
