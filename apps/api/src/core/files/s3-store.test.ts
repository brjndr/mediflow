import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3FileStore } from './s3-store.js';
import { signImageDownload, verifyImageDownload } from './signing.js';

// Runs against RustFS (`docker compose --profile full up -d`, or the CI service); skipped without it.
const endpoint = process.env.S3_TEST_ENDPOINT ?? process.env.S3_ENDPOINT;
const credentials = {
  accessKeyId: process.env.MINIO_ROOT_USER ?? 'mediflow',
  secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'mediflow-dev-secret',
};

describe.skipIf(!endpoint)('S3FileStore against an S3-compatible service', () => {
  const bucket = `files-${randomUUID().slice(0, 8)}`;
  let store: S3FileStore;

  beforeAll(async () => {
    const admin = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials,
    });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    admin.destroy();
    store = new S3FileStore({ bucket, region: 'us-east-1', endpoint, ...credentials });
  });

  it('writes, reads and deletes a file', async () => {
    const key = 'tenant-a/reports/run-1.csv';
    await store.put(key, Buffer.from('a,b\n1,2\n'));
    expect((await store.get(key))?.toString()).toBe('a,b\n1,2\n');
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("keeps one hospital's key apart from another's and refuses a bad key", async () => {
    await store.put('tenant-a/x.pdf', Buffer.from('a'));
    expect(await store.get('tenant-b/x.pdf')).toBeNull();
    await expect(store.put('../x', Buffer.from('a'))).rejects.toThrow('invalid_file_key');
    await expect(store.get('a//b')).rejects.toThrow('invalid_file_key');
  });

  it('a signed link for one file does not verify for another, or after it expires', () => {
    const secret = Buffer.alloc(32, 1).toString('base64');
    const now = 1000;
    const sig = signImageDownload(secret, 'image-a', now + 60);
    expect(verifyImageDownload(secret, 'image-a', now + 60, sig, now)).toBe(true);
    expect(verifyImageDownload(secret, 'image-b', now + 60, sig, now)).toBe(false);
    expect(verifyImageDownload(secret, 'image-a', now + 60, sig, now + 61)).toBe(false);
  });
});
