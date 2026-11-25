import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTenant,
  deleteTenants,
  type TestTenant,
} from '../../../test/helpers.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { insertAuditEntries } from './plugin.js';
import { PLATFORM_CHAIN, sealAuditLog, verifyAuditSeals } from './seal.js';
import { forkedSeals } from './seal-logs.js';
import { copySeals, MemorySealMirror } from './seal-mirror.js';

let app: FastifyInstance;
let pool: pg.Pool;
const key = Buffer.alloc(32, 7);

beforeAll(async () => {
  app = await buildTestApp();
  pool = app.database.pool;
});

afterAll(async () => {
  await app.close();
});

const write = (tenant: TestTenant, entity: string, count = 1) =>
  withTenantTransaction(pool, tenant.id, (client) =>
    insertAuditEntries(
      client,
      'user_sealer',
      'req-mirror',
      Array.from({ length: count }, (_, n) => ({
        action: 'read',
        entity,
        entityId: `${entity}-${n}`,
      })),
    ),
  );

/** Runs `sql` as the owner with the triggers off, as someone with the whole database could. */
async function tamper(sql: string, params: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(sql, params);
    await client.query('commit');
  } finally {
    client.release();
  }
}

const sealsOf = async (tenantId: string) =>
  (
    await pool.query<{ id: string }>(
      'select id from audit_seal where tenant_id = $1 order by xid_from',
      [tenantId],
    )
  ).rows;

async function withHospital(name: string, run: (tenant: TestTenant) => Promise<void>) {
  const tenant = await createTenant(pool, name);
  try {
    await run(tenant);
  } finally {
    await deleteTenants(pool, [tenant]);
  }
}

describe('write-once copies of the audit seals (#1092)', () => {
  it('reports a chain made again after its tail was removed', async () => {
    await withHospital('Mirror Rewritten', async (tenant) => {
      const mirror = new MemorySealMirror();
      const mine = async () =>
        (await sealAuditLog(pool, key)).filter((s) => s.tenantId === tenant.id);
      await write(tenant, 'a', 2);
      expect(await copySeals(mirror, await mine())).toEqual([]);
      await write(tenant, 'b', 2);
      await copySeals(mirror, await mine());
      const check = async () =>
        (
          await verifyAuditSeals(pool, key, { scope: 'all', mirror, mirrorOverdueMinutes: 0 })
        ).mismatches
          .filter((m) => m.tenantId === tenant.id)
          .map((m) => m.problem);
      expect(await check()).toEqual([]);

      // The last seal removed, its rows changed, and the job seals them again with its own key.
      const [, last] = await sealsOf(tenant.id);
      await tamper('delete from audit_seal where id = $1', [last!.id]);
      await tamper(
        "update audit_log set entity_id = 'edited' where tenant_id = $1 and entity_id = 'b-0'",
        [tenant.id],
      );
      await sealAuditLog(pool, key);
      // On its own the database is consistent again; only the copy shows it.
      const alone = await verifyAuditSeals(pool, key, { scope: 'all' });
      expect(alone.mismatches.filter((m) => m.tenantId === tenant.id)).toEqual([]);
      expect(await check()).toEqual(['chain_rewritten']);
    });
  });

  it('reports a seal with no copy once overdue, and all seals removed', async () => {
    await withHospital('Mirror Missing', async (tenant) => {
      const mirror = new MemorySealMirror();
      await write(tenant, 'a');
      const written = (await sealAuditLog(pool, key)).filter((s) => s.tenantId === tenant.id);
      const check = async (overdue: number) =>
        (
          await verifyAuditSeals(pool, key, { scope: 'all', mirror, mirrorOverdueMinutes: overdue })
        ).mismatches
          .filter((m) => m.tenantId === tenant.id)
          .map((m) => m.problem);
      expect(await check(0)).toEqual(['mirror_missing']);
      expect(await check(60)).toEqual([]);
      mirror.failNext = true;
      expect(await copySeals(mirror, written)).toHaveLength(1);
      await copySeals(mirror, written);
      expect(await check(0)).toEqual([]);
      await tamper('delete from audit_seal where tenant_id = $1', [tenant.id]);
      expect(await check(0)).toContain('chain_rewritten');
    });
  });
});

describe('the platform audit log chain (#1092)', () => {
  it('is sealed, and a changed row is reported', async () => {
    const problems = async () =>
      (await verifyAuditSeals(pool, key, { scope: 'all' })).mismatches
        .filter((m) => m.tenantId === PLATFORM_CHAIN)
        .map((m) => m.problem);
    await pool.query(
      `insert into platform_audit_log (actor_id, action, entity, entity_id)
       values (gen_random_uuid(), 'test.seal', 'hospital', 'seal-test')`,
    );
    const written = await sealAuditLog(pool, key);
    expect(written.some((s) => s.tenantId === PLATFORM_CHAIN)).toBe(true);
    expect(await problems()).toEqual([]);
    const change = 'update platform_audit_log set entity_id = $1 where entity_id = $2';
    await tamper(change, ['edited', 'seal-test']);
    expect(await problems()).toEqual(['digest_mismatch']);
    // The log is shared with other tests, so the row is put back.
    await tamper(change, ['seal-test', 'edited']);
    expect(await problems()).toEqual([]);
  });
});

describe('the log-side check', () => {
  it('finds two seals after the same one', () => {
    const line = (seal: string, prevSeal: string | null) =>
      JSON.stringify({ event: 'audit_sealed', tenantId: 't1', seal, prevSeal });
    expect(forkedSeals([line('b', 'a'), line('c', 'b'), 'not json'])).toEqual([]);
    expect(forkedSeals([line('b', 'a'), line('c', 'b'), line('d', 'b')])).toEqual([
      { tenantId: 't1', prevSeal: 'b', seals: ['c', 'd'] },
    ]);
  });
});
