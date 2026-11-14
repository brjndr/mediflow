import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3FileStore } from '../src/core/files/s3-store.js';
import { LocalFileStore, type FileStore } from '../src/core/files/store.js';

/** Set when an S3-compatible service is running (CI starts one; see core/files/CLAUDE.md). */
export const s3Endpoint = process.env.S3_TEST_ENDPOINT ?? process.env.S3_ENDPOINT;

export interface TestFileStore {
  store: FileStore;
  /** True when the files are in a bucket, false when in a folder. */
  isS3: boolean;
  cleanup(): Promise<void>;
}

/**
 * The store a test writes to: a fresh bucket of the S3-compatible service when `S3_TEST_ENDPOINT`
 * is set, otherwise a temporary folder, so the same tests cover both adapters.
 */
export async function makeTestFileStore(prefix: string): Promise<TestFileStore> {
  if (!s3Endpoint) {
    const folder = await mkdtemp(path.join(tmpdir(), `mediflow-${prefix}-`));
    return {
      store: new LocalFileStore(folder),
      isS3: false,
      cleanup: () => rm(folder, { recursive: true, force: true }),
    };
  }
  const credentials = {
    accessKeyId: process.env.MINIO_ROOT_USER ?? 'mediflow',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'mediflow-dev-secret',
  };
  const bucket = `${prefix}-${randomUUID().slice(0, 8)}`;
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials,
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  admin.destroy();
  const store = new S3FileStore({
    bucket,
    region: 'us-east-1',
    endpoint: s3Endpoint,
    ...credentials,
  });
  return { store, isS3: true, cleanup: async () => store.close() };
}
