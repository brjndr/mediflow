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
import { MemoryQueue } from '../jobs/queue.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
import { insertAuditEntries } from './plugin.js';
import { sealAuditLog, sealOf, verifyAuditSeals } from './seal.js';

let app: FastifyInstance;
let pool: pg.Pool;
let queue: MemoryQueue;
let hospital: TestTenant;
let clinic: TestTenant;
const key = Buffer.alloc(32, 7);
// The test configuration's key (thirty-two zero bytes), which the jobs use.
const appKey = Buffer.alloc(32, 0);

beforeAll(async () => {
  queue = new MemoryQueue();
  app = await buildTestApp({ jobQueue: queue });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Seal General');
  clinic = await createTenant(pool, 'Seal Clinic');
});

afterAll(async () => {
  // Audit rows and seals are append-only, and the test hospitals are removed without the deletion
  // job, so they stay in the test database.
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

/** Writes audit rows in one transaction and commits them, as a request does. */
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

const seals = async (tenantId: string) =>
  (
    await pool.query<{
      id: string;
      xid_from: string;
      xid_to: string;
      row_count: string;
      seal: Buffer;
    }>(
      `select id, xid_from::text, xid_to::text, row_count, seal from audit_seal
       where tenant_id = $1 order by xid_from`,
      [tenantId],
    )
  ).rows;

const problemsFor = async (tenantId: string) => {
  const { mismatches } = await verifyAuditSeals(pool, key, { scope: 'all' });
  return mismatches
    .filter((m) => m.tenantId === tenantId)
    .map((m) => m.problem)
    .sort();
};

/** A hospital of its own for a test that changes rows or seals, removed at the end. */
async function withHospital(name: string, run: (tenant: TestTenant) => Promise<void>) {
  const tenant = await createTenant(pool, name);
  try {
    await run(tenant);
  } finally {
    await deleteTenants(pool, [tenant]);
  }
}

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

  it('writes nothing when there is nothing new', async () => {
    const before = (await seals(hospital.id)).length;
    const written = await sealAuditLog(pool, key);
    expect(written.filter((s) => s.tenantId === hospital.id)).toEqual([]);
    expect(await seals(hospital.id)).toHaveLength(before);
  });

  it('seals new rows once when two runs race', async () => {
    await withHospital('Seal Race', async (tenant) => {
      await write(tenant, 'patient', 4);
      const [first, second] = await Promise.all([sealAuditLog(pool, key), sealAuditLog(pool, key)]);
      const mine = [...first, ...second].filter((s) => s.tenantId === tenant.id);
      expect(mine.map((s) => s.rowCount)).toEqual([4]);
      expect(await seals(tenant.id)).toHaveLength(1);
      expect(await problemsFor(tenant.id)).toEqual([]);
    });
  });

  it('seals a backlog in parts, never splitting one transaction', async () => {
    await withHospital('Seal Backlog', async (tenant) => {
      for (let n = 0; n < 5; n++) await write(tenant, `t${n}`);
      await write(tenant, 'bulk', 3);
      const written = (await sealAuditLog(pool, key, { maxRows: 2 })).filter(
        (s) => s.tenantId === tenant.id,
      );
      // Five one-row transactions in parts of two, then the three-row transaction on its own.
      expect(written.map((s) => s.rowCount)).toEqual([2, 2, 1, 3]);
      for (let n = 1; n < written.length; n++) {
        expect(written[n]!.xidFrom).toBe(written[n - 1]!.xidTo);
        expect(written[n]!.prevSeal).toBe(written[n - 1]!.seal);
      }
      expect(await problemsFor(tenant.id)).toEqual([]);
    });
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

  it('gives a row written by the app its own transaction id, and refuses a time it chose', async () => {
    await withHospital('Seal Stamp', async (tenant) => {
      for (const at of ["now() - interval '1 hour'", "now() + interval '1 hour'"]) {
        await expect(
          withTenantTransaction(pool, tenant.id, (client) =>
            client.query(
              `insert into audit_log (tenant_id, at, actor_id, action, entity)
               values (app_tenant_id(), ${at}, 'user_forger', 'read', 'patient')`,
            ),
          ),
        ).rejects.toMatchObject({ code: '23001' });
      }
      await withTenantTransaction(pool, tenant.id, (client) =>
        client.query(
          `insert into audit_log (tenant_id, actor_id, action, entity, xid)
           values (app_tenant_id(), 'user_forger', 'read', 'patient', '1'::xid8)`,
        ),
      );
      const { rows } = await pool.query<{ xid: string }>(
        'select xid::text from audit_log where tenant_id = $1',
        [tenant.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.xid).not.toBe('1');
    });
  });

  it('reports a row changed and a row removed', async () => {
    await withHospital('Seal Tampered', async (tenant) => {
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
    });
  });

  it('reports a backdated row given an old transaction id', async () => {
    await withHospital('Seal Backdated', async (tenant) => {
      await write(tenant, 'patient', 2);
      await sealAuditLog(pool, key);
      const [sealRow] = await seals(tenant.id);
      await tamper(
        `insert into audit_log (tenant_id, actor_id, action, entity, entity_id, xid)
         values ($1, 'user_forger', 'read', 'patient', 'forged', $2::xid8)`,
        [tenant.id, sealRow!.xid_from],
      );
      expect(await problemsFor(tenant.id)).toEqual(['digest_mismatch']);
    });
  });

  it('reports a seal removed from inside a chain, and a seal made without the key', async () => {
    await withHospital('Seal Chain', async (tenant) => {
      for (const entity of ['a', 'b', 'c']) {
        await write(tenant, entity);
        await sealAuditLog(pool, key);
      }
      const chain = await seals(tenant.id);
      expect(chain).toHaveLength(3);

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
      expect(await problemsFor(tenant.id)).toEqual(['chain_gap', 'seal_mismatch']);
    });
  });

  it('reports a seal that names the wrong seal before it, and a first seal that names one', async () => {
    await withHospital('Seal Links', async (tenant) => {
      for (const entity of ['a', 'b']) {
        await write(tenant, entity);
        await sealAuditLog(pool, key);
      }
      const [first, second] = await seals(tenant.id);
      await tamper('update audit_seal set prev_seal = $2 where id = $1', [
        second!.id,
        Buffer.alloc(32, 1),
      ]);
      await tamper('update audit_seal set prev_seal = $2 where id = $1', [
        first!.id,
        Buffer.alloc(32, 2),
      ]);
      // Each changed seal also fails its HMAC, which covers the seal it names.
      expect(await problemsFor(tenant.id)).toEqual([
        'chain_link_mismatch',
        'chain_start',
        'seal_mismatch',
        'seal_mismatch',
      ]);
    });
  });

  it('reports a hospital whose rows sealing has left behind', async () => {
    await withHospital('Seal Lagging', async (tenant) => {
      // As the owner, who may set the time: a row two hours old that no run has sealed.
      await pool.query(
        `insert into audit_log (tenant_id, at, actor_id, action, entity)
         values ($1, now() - interval '2 hours', 'user_late', 'read', 'patient')`,
        [tenant.id],
      );
      expect(await problemsFor(tenant.id)).toEqual(['unsealed']);
      await sealAuditLog(pool, key);
      expect(await problemsFor(tenant.id)).toEqual([]);
    });
  });

  it('checks only recent seals and a sample unless asked for all', async () => {
    const later = new Date(Date.now() + 60_000);
    const all = await verifyAuditSeals(pool, key, { scope: 'all' });
    const none = await verifyAuditSeals(pool, key, { scope: 'recent', since: later, sample: 0 });
    const sampled = await verifyAuditSeals(pool, key, { scope: 'recent', since: later, sample: 1 });
    expect(all.checked).toBeGreaterThan(1);
    expect(none.checked).toBe(0);
    expect(sampled.checked).toBe(1);
  });

  it('skips only the seals whose rows reach into retired months', async () => {
    await withHospital('Seal Retired', async (tenant) => {
      await pool.query(
        `insert into audit_log (tenant_id, at, actor_id, action, entity)
         values ($1, now() - interval '3 days', 'user_old', 'read', 'patient')`,
        [tenant.id],
      );
      await sealAuditLog(pool, key);
      await write(tenant, 'patient');
      await sealAuditLog(pool, key);
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
      const { rows } = await pool.query<{ n: string }>(
        'select count(*) as n from audit_seal where min_at < $1',
        [cutoff],
      );
      const everything = await verifyAuditSeals(pool, key, { scope: 'all' });
      const kept = await verifyAuditSeals(pool, key, { scope: 'all', retainedFrom: cutoff });
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
      expect(everything.checked - kept.checked).toBe(Number(rows[0]!.n));
    });
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

  it('runs as jobs: sealing every five minutes, checking daily without retries', async () => {
    expect(queue.schedules).toEqual(
      expect.arrayContaining([
        { name: 'audit.seal', cron: '*/5 * * * *', options: undefined },
        {
          name: 'audit.seal-verify',
          cron: '30 4 * * *',
          options: { expireInSeconds: 6 * 3600, retryLimit: 0 },
        },
      ]),
    );
    await withHospital('Seal Jobs', async (tenant) => {
      await write(tenant, 'patient', 2);
      await queue.send('audit.seal', {});
      await queue.drain();
      const [sealRow] = await seals(tenant.id);
      expect(Number(sealRow?.row_count)).toBe(2);
      // Made with the app's key, so the job's own check finds it sound.
      const { mismatches } = await verifyAuditSeals(pool, appKey, { scope: 'all' });
      expect(mismatches.filter((m) => m.tenantId === tenant.id)).toEqual([]);

      // A changed row fails the check job (this file's own changed hospitals fail it too).
      await tamper("update audit_log set entity_id = 'x' where tenant_id = $1", [tenant.id]);
      await queue.send('audit.seal-verify', {});
      await expect(queue.drain()).rejects.toThrow('audit_seal_mismatch');
    });
  });
});
