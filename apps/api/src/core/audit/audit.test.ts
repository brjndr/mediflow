import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ensureAuditPartitions } from './plugin.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from '../../../test/helpers.js';

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;

const member = { permissions: [] };

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    extend(instance) {
      instance.get<{ Params: { id: string } }>(
        '/things/:id',
        { config: { ...member, audit: { entity: 'thing' } } },
        async (request) => ({ id: request.params.id }),
      );
      // The entity name is longer than the column allows, so the audit insert is refused.
      instance.post('/things/too-long', { config: member }, async (request) => {
        request.audit('read', 'x'.repeat(64));
        return { ok: true };
      });
      instance.post<{ Body: { fail?: boolean } }>(
        '/things',
        { config: member },
        async (request) => {
          request.audit('bulk_import', 'thing');
          if (request.body.fail) throw new Error('failed after auditing');
          return { ok: true };
        },
      );
    },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Audit General');
  clinic = await createTenant(pool, 'Audit Clinic');
});

afterAll(async () => {
  // Audit rows outlive their hospital and cannot be deleted, so only the hospitals are removed.
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

const auditRows = (tenantId: string) =>
  asTenantSql(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      actor_id: string;
      action: string;
      entity: string;
      entity_id: string | null;
      partition: string;
    }>(
      `select actor_id, action, entity, entity_id, tableoid::regclass::text as partition
       from audit_log order by at`,
    );
    return rows;
  });

describe('audit log', () => {
  it('records a read of a declared route with the actor and the record id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/things/abc',
      headers: as(hospital.id, 'user_reader'),
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRows(hospital.id);
    expect(rows).toEqual([
      expect.objectContaining({
        actor_id: 'user_reader',
        action: 'read',
        entity: 'thing',
        entity_id: 'abc',
      }),
    ]);
    // A monthly partition took it, not the catch-all.
    expect(rows[0]?.partition).toMatch(/^audit_log_\d{4}_\d{2}$/);
  });

  it('records nothing when the request fails', async () => {
    const before = (await auditRows(hospital.id)).length;
    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: as(hospital.id),
      payload: { fail: true },
    });
    expect(response.statusCode).toBe(500);
    expect(await auditRows(hospital.id)).toHaveLength(before);
  });

  it('records an entry added by the handler once the request succeeds', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/things',
      headers: as(hospital.id),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect((await auditRows(hospital.id)).map((row) => row.action)).toContain('bulk_import');
  });

  it('keeps one hospital out of the other hospital audit trail', async () => {
    expect(await auditRows(clinic.id)).toEqual([]);
    await asTenantSql(pool, clinic.id, async (client) => {
      await expect(
        client.query(
          "insert into audit_log (tenant_id, action, entity) values ($1, 'read', 'thing')",
          [hospital.id],
        ),
      ).rejects.toThrow(/row-level security policy/);
    });
  });

  it('cannot be changed or deleted', async () => {
    await asTenantSql(pool, hospital.id, async (client) => {
      await client.query('savepoint s1');
      await expect(client.query("update audit_log set action = 'x'")).rejects.toMatchObject({
        code: '42501',
      });
      await client.query('rollback to savepoint s1');
      await expect(client.query('delete from audit_log')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('creates upcoming monthly partitions idempotently, as the worker role only', async () => {
    const month = "(now() + interval '14 months')::date";
    await ensureAuditPartitions(pool);
    for (let run = 0; run < 2; run++) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role mediflow_worker');
        await client.query(`select ensure_audit_partition(${month})`);
      } finally {
        await client.query('rollback');
        client.release();
      }
    }
    await pool.query(`select ensure_audit_partition(${month})`);
    const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where relname = 'audit_log_' || to_char(now() + interval '14 months', 'YYYY_MM')`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    // A tenant request cannot create partitions.
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query(`select ensure_audit_partition(${month})`)).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('refuses truncating the table or any partition, and direct access to a partition', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `select inhrelid::regclass::text as name from pg_inherits
       where inhparent = 'audit_log'::regclass`,
    );
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.map((row) => row.name)).toContain('audit_log_default');
    for (const name of ['audit_log', ...rows.map((row) => row.name)]) {
      await expect(pool.query(`truncate ${name}`), name).rejects.toMatchObject({ code: '23001' });
    }
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('select * from audit_log_default')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('stops the app from starting when a non-tenant route asks for auditing', async () => {
    let failure: unknown;
    const other = await buildTestApp({
      extend(instance) {
        try {
          instance.get(
            '/open',
            { config: { access: 'public', audit: { entity: 'thing' } } },
            async () => ({}),
          );
        } catch (error) {
          failure = error;
        }
      },
    });
    await other.close();
    expect(String(failure)).toMatch(/config\.audit but is not a tenant route/);
  });

  it('fails the request, keeps nothing and frees the connection when the audit insert fails', async () => {
    const before = (await auditRows(hospital.id)).length;
    const response = await app.inject({
      method: 'POST',
      url: '/things/too-long',
      headers: as(hospital.id),
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(await auditRows(hospital.id)).toHaveLength(before);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  });
});
