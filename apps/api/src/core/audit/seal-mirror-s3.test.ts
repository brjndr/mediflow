import { CreateBucketCommand, GetObjectRetentionCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3SealMirror, sealKeyOf } from './seal-mirror.js';

/**
 * Against a real S3-compatible service with Object Lock (#1158). Runs when `S3_TEST_ENDPOINT` is
 * set (RustFS in CI). A service that cannot create a bucket with Object Lock skips the test.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const credentials = { accessKeyId: 'mediflow', secretAccessKey: 'mediflow-dev-secret' };

describe.skipIf(!endpoint)('S3SealMirror on a bucket with Object Lock', () => {
  it('writes, lists and locks a copy in compliance mode', async (ctx) => {
    const bucket = `seals-${randomUUID().slice(0, 8)}`;
    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials,
    });
    try {
      await client.send(
        new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }),
      );
    } catch {
      ctx.skip();
    }
    const mirror = new S3SealMirror({
      bucket,
      region: 'us-east-1',
      endpoint,
      ...credentials,
      retentionMonths: 1,
    });
    const tenantId = randomUUID();
    const seal = {
      tenantId,
      xidFrom: '10',
      xidTo: '20',
      seal: 'ab'.repeat(32),
      prevSeal: null,
      rowCount: 3,
    };
    await mirror.put(seal);
    expect(await mirror.list(tenantId)).toEqual([{ xidFrom: '10', xidTo: '20', seal: seal.seal }]);
    expect(await mirror.tenants()).toContain(tenantId);

    const retention = await client.send(
      new GetObjectRetentionCommand({ Bucket: bucket, Key: sealKeyOf(seal) }),
    );
    expect(retention.Retention?.Mode).toBe('COMPLIANCE');
    expect(retention.Retention!.RetainUntilDate!.getTime()).toBeGreaterThan(Date.now());
    // Refusing a delete under retention is the service's job: RustFS keeps the retention but
    // does not enforce it (found in #1158), so that is checked on a real bucket by a person.
  });
});
