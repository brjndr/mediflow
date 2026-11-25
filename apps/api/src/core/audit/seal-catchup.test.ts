import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, deleteTenants } from '../../../test/helpers.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { insertAuditEntries } from './plugin.js';
import { sealAuditLog } from './seal.js';
import { copyMissingSeals, throttledCatchup } from './seal-catchup.js';
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

describe('throttled catch-up (#1168)', () => {
  it('lists the bucket once an hour, and at once after a failed copy', async () => {
    const a = await createTenant(pool, 'Throttle A');
    const b = await createTenant(pool, 'Throttle B');
    try {
      await write(a.id, 'p1');
      await write(b.id, 'p2');
      await sealAuditLog(pool, key);
      const mirror = new MemorySealMirror();
      let lists = 0;
      const list = mirror.list.bind(mirror);
      mirror.list = async (t) => {
        lists++;
        return list(t);
      };
      let clock = 0;
      const run = throttledCatchup(pool, mirror, {
        everyMinutes: 60,
        graceMinutes: -1,
        now: () => clock,
      });
      await run();
      const first = lists;
      expect(first).toBeGreaterThan(0);
      clock += 10 * 60_000;
      await run();
      expect(lists).toBe(first);
      await run(true);
      expect(lists).toBeGreaterThan(first);
      const second = lists;
      clock += 61 * 60_000;
      await run();
      expect(lists).toBeGreaterThan(second);
    } finally {
      await deleteTenants(pool, [a, b]);
    }
  });
});
