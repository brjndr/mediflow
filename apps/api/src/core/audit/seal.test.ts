import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asTenantSql,
  buildTestApp,
  createTenant,
  deleteTenants,
  type TestTenant,
} from '../../../test/helpers.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { insertAuditEntries } from './plugin.js';
import { sealAuditLog, sealOf, verifyAuditSeals } from './seal.js';

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
const key = Buffer.alloc(32, 7);

beforeAll(async () => {
  app = await buildTestApp();
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Seal General');
  clinic = await createTenant(pool, 'Seal Clinic');
});

afterAll(async () => {
  // Audit rows and seals outlive their hospital and cannot be deleted, so only the hospitals go.
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

/** Writes audit rows and commits them, as a request does. */
const write = (tenant: TestTenant, entity: string, count = 1) =>
  withTenantTransaction(pool, tenant.id, (client) =>
    insertAuditEntries(
      client,
      'user_sealer',
      'req-seal',
      Array.from({ length: count }, (_, n) => ({
        action: 'read',
        entity,
        entityId: `${entity}-${n}`,
      })),
    ),
  );

/** Runs `sql` as the owner with the append-only triggers off, as someone with the database could. */
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

const seals = async (tenantId: string) =>
  (
    await pool.query<{ id: string; xid_from: string; xid_to: string; row_count: string }>(
      `select id, xid_from::text, xid_to::text, row_count from audit_seal
       where tenant_id = $1 order by xid_from`,
      [tenantId],
    )
  ).rows;

const problemsFor = async (tenantId: string) => {
  const { mismatches } = await verifyAuditSeals(pool, key, { scope: 'all' });
  return mismatches.filter((m) => m.tenantId === tenantId).map((m) => m.problem);
};

describe('audit log seals', () => {
  it('seals each hospital on its own, chained from 0, and every seal verifies', async () => {
    await write(hospital, 'patient', 3);
    await write(clinic, 'patient', 2);
    await sealAuditLog(pool, key);
    await write(hospital, 'invoice', 2);
    await sealAuditLog(pool, key);

    const chain = await seals(hospital.id);
    expect(chain.map((s) => Number(s.row_count))).toEqual([3, 2]);
    expect(chain[0]!.xid_from).toBe('0');
    expect(chain[1]!.xid_from).toBe(chain[0]!.xid_to);
    expect((await seals(clinic.id)).map((s) => Number(s.row_count))).toEqual([2]);

    expect(await problemsFor(hospital.id)).toEqual([]);
    expect(await problemsFor(clinic.id)).toEqual([]);
  });

  it('writes nothing when there is nothing new, and nothing twice', async () => {
    const before = (await seals(hospital.id)).length;
    const [first, second] = await Promise.all([sealAuditLog(pool, key), sealAuditLog(pool, key)]);
    expect([...first, ...second].filter((s) => s.tenantId === hospital.id)).toEqual([]);
    expect(await seals(hospital.id)).toHaveLength(before);
  });

  it('never seals rows of a transaction that is still open', async () => {
    const open = await pool.connect();
    try {
      await open.query('begin');
      await open.query('set local role mediflow_app');
      await open.query("select set_config('app.tenant_id', $1, true)", [clinic.id]);
      await insertAuditEntries(open, 'user_slow', 'req-slow', [
        { action: 'read', entity: 'slow', entityId: 's1' },
      ]);
      // Committed after the open one began, so its id is higher: it must wait for the open one.
      await write(clinic, 'later');
      const sealed = (await sealAuditLog(pool, key)).filter((s) => s.tenantId === clinic.id);
      expect(sealed).toEqual([]);
      await open.query('commit');
    } finally {
      open.release();
    }
    const sealed = (await sealAuditLog(pool, key)).filter((s) => s.tenantId === clinic.id);
    expect(sealed.map((s) => s.rowCount)).toEqual([2]);
    expect(await problemsFor(clinic.id)).toEqual([]);
  });

  it('reports a row changed, a row removed and a row slipped into a sealed range', async () => {
    const tenant = await createTenant(pool, 'Seal Tampered');
    try {
      await write(tenant, 'patient', 3);
      await sealAuditLog(pool, key);
      expect(await problemsFor(tenant.id)).toEqual([]);

      await tamper(
        "update audit_log set entity_id = 'someone-else' where tenant_id = $1 and entity_id = 'patient-0'",
        [tenant.id],
      );
      expect(await problemsFor(tenant.id)).toEqual(['digest_mismatch']);

      await tamper(
        "update audit_log set entity_id = 'patient-0' where tenant_id = $1 and entity_id = 'someone-else'",
        [tenant.id],
      );
      expect(await problemsFor(tenant.id)).toEqual([]);

      await tamper("delete from audit_log where tenant_id = $1 and entity_id = 'patient-1'", [
        tenant.id,
      ]);
      expect(await problemsFor(tenant.id)).toEqual(['digest_mismatch']);
    } finally {
      await deleteTenants(pool, [tenant]);
    }
  });

  it('reports a backdated row given an old transaction id', async () => {
    const tenant = await createTenant(pool, 'Seal Backdated');
    try {
      await write(tenant, 'patient', 2);
      await sealAuditLog(pool, key);
      const [sealRow] = await seals(tenant.id);
      await tamper(
        `insert into audit_log (tenant_id, actor_id, action, entity, entity_id, xid)
         values ($1, 'user_forger', 'read', 'patient', 'forged', $2::xid8)`,
        [tenant.id, sealRow!.xid_from],
      );
      expect(await problemsFor(tenant.id)).toEqual(['digest_mismatch']);
    } finally {
      await deleteTenants(pool, [tenant]);
    }
  });

  it('reports a seal removed from the middle of a chain, and a seal made without the key', async () => {
    const tenant = await createTenant(pool, 'Seal Chain');
    try {
      for (const entity of ['a', 'b', 'c']) {
        await write(tenant, entity);
        await sealAuditLog(pool, key);
      }
      const chain = await seals(tenant.id);
      expect(chain).toHaveLength(3);

      // A seal rebuilt with the right digest but another key does not pass.
      await tamper('update audit_seal set seal = $2 where id = $1', [
        chain[2]!.id,
        sealOf(Buffer.alloc(32, 9), {
          tenantId: tenant.id,
          xidFrom: chain[2]!.xid_from,
          xidTo: chain[2]!.xid_to,
          rowCount: 1,
          minAt: new Date(),
          digest: Buffer.alloc(32),
          prevSeal: null,
        }),
      ]);
      await tamper('delete from audit_seal where id = $1', [chain[1]!.id]);
      expect((await problemsFor(tenant.id)).sort()).toEqual(['chain_gap', 'seal_mismatch']);
    } finally {
      await deleteTenants(pool, [tenant]);
    }
  });

  it('checks only recent seals and a sample unless asked for all', async () => {
    const all = await verifyAuditSeals(pool, key, { scope: 'all' });
    const none = await verifyAuditSeals(pool, key, {
      scope: 'recent',
      since: new Date(Date.now() + 60_000),
      sample: 0,
    });
    const sampled = await verifyAuditSeals(pool, key, {
      scope: 'recent',
      since: new Date(Date.now() + 60_000),
      sample: 1,
    });
    expect(all.checked).toBeGreaterThan(1);
    expect(none.checked).toBe(0);
    expect(sampled.checked).toBe(1);
  });

  it('skips seals whose rows reach into retired months', async () => {
    const { checked } = await verifyAuditSeals(pool, key, {
      scope: 'all',
      retainedFrom: new Date(Date.now() + 60_000),
    });
    expect(checked).toBe(0);
  });

  it('lets a hospital read its own seals only, and write none', async () => {
    await asTenantSql(pool, clinic.id, async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>(
        'select distinct tenant_id from audit_seal',
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([clinic.id]);
      await client.query('savepoint before_insert');
      await expect(
        client.query(
          `insert into audit_seal (tenant_id, xid_from, xid_to, row_count, min_at, digest, seal)
           values ($1, '0', '1', 1, now(), $2, $2)`,
          [clinic.id, Buffer.alloc(32)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint before_insert');
      await expect(client.query('select audit_seal_due($1::xid8)', ['1'])).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('cannot be changed or deleted, even by the job role', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_worker');
      await client.query('savepoint s1');
      await expect(client.query('update audit_seal set row_count = 1')).rejects.toBeTruthy();
      await client.query('rollback to savepoint s1');
      await expect(client.query('delete from audit_seal')).rejects.toBeTruthy();
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
