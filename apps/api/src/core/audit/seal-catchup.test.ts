import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, deleteTenants } from '../../../test/helpers.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { insertAuditEntries } from './plugin.js';
import { sealAuditLog } from './seal.js';
import { copyMissingSeals } from './seal-catchup.js';
import { copySeals, MemorySealMirror } from './seal-mirror.js';

let app: FastifyInstance;
let pool: pg.Pool;
const key = Buffer.alloc(32, 9);

beforeAll(async () => {
  app = await buildTestApp();
  pool = app.database.pool;
});
afterAll(async () => {
  await app.close();
});

const write = (tenantId: string, id: string) =>
  withTenantTransaction(pool, tenantId, (client) =>
    insertAuditEntries(client, 'user_c', `req-${id}`, [
      { action: 'read', entity: 'patient', entityId: id },
    ]),
  );

describe('copying seals that have no copy (#1158)', () => {
  it('copies a seal whose first copy failed, and only once', async () => {
    const tenant = await createTenant(pool, 'Seal Catchup');
    try {
      await write(tenant.id, 'p1');
      const written = (await sealAuditLog(pool, key)).filter((s) => s.tenantId === tenant.id);
      expect(written).toHaveLength(1);
      const mirror = new MemorySealMirror();
      mirror.failNext = true;
      expect(await copySeals(mirror, written)).toHaveLength(1);
      expect(await mirror.list(tenant.id)).toEqual([]);

      // Just written: left to the run that wrote it.
      await copyMissingSeals(pool, mirror);
      expect(await mirror.list(tenant.id)).toEqual([]);

      await copyMissingSeals(pool, mirror, { graceMinutes: -1 });
      expect(await mirror.list(tenant.id)).toHaveLength(1);
      const copy = [...mirror.objects.values()].find((s) => s.tenantId === tenant.id);
      expect(copy?.seal).toBe(written[0]!.seal);
      expect(copy?.rowCount).toBe(1);

      const before = mirror.objects.size;
      await copyMissingSeals(pool, mirror, { graceMinutes: -1 });
      expect(mirror.objects.size).toBe(before);
    } finally {
      await deleteTenants(pool, [tenant]);
    }
  });

  it('returns the seals still without a copy while the bucket is down', async () => {
    const tenant = await createTenant(pool, 'Seal Catchup Down');
    try {
      await write(tenant.id, 'p2');
      await sealAuditLog(pool, key);
      const mirror = new MemorySealMirror();
      mirror.put = async () => {
        throw new Error('mirror_unavailable');
      };
      const still = await copyMissingSeals(pool, mirror, { graceMinutes: -1 });
      expect(still.some((s) => s.tenantId === tenant.id)).toBe(true);
    } finally {
      await deleteTenants(pool, [tenant]);
    }
  });
});
