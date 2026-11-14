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

describe.skipIf(!endpoint)('presigned addresses', () => {
  const bucket = `presign-${randomUUID().slice(0, 8)}`;
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

  it('uploads with the signed type and size only, and reports the size', async () => {
    const key = 'tenant-a/up/1';
    const url = await store.presignUpload(key, {
      contentType: 'image/png',
      size: 4,
      ttlSeconds: 60,
    });
    const put = (type: string, body: string) =>
      fetch(url, { method: 'PUT', headers: { 'content-type': type }, body });
    expect((await put('image/jpeg', 'abcd')).ok).toBe(false);
    expect((await put('image/png', 'abcde')).ok).toBe(false);
    expect(await store.size(key)).toBeNull();
    expect((await put('image/png', 'abcd')).ok).toBe(true);
    expect(await store.size(key)).toBe(4);
  });

  it('downloads with the given name and type, and not another key', async () => {
    await store.put('tenant-a/down/1', Buffer.from('hello'));
    const url = await store.presign('tenant-a/down/1', 60, {
      fileName: 'a b"c.txt',
      contentType: 'text/plain',
    });
    const response = await fetch(url);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="a b_c.txt"');
    const other = await fetch(url.replace('tenant-a/down/1', 'tenant-b/down/1'));
    expect(other.ok).toBe(false);
    await expect(store.presign('../x', 60)).rejects.toThrow('invalid_file_key');
  });
});
