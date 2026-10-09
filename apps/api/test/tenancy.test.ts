import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  deleteTenants,
  resolveTestSession,
  type TestTenant,
} from './helpers.js';

/**
 * Tenant isolation, the first non-negotiable: hospital A must never read or write hospital B's
 * rows, whether it goes through the API or straight through SQL under the app role.
 *
 * `rls_probe` is a scratch table set up exactly as a real tenant table would be, with the
 * template. It exists so writes can be tested before any writable product table does.
 */

const RLS_VIOLATION = /row-level security policy/;

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let suspended: TestTenant;

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    // Test-only routes that write through the request's transaction, as a feature would.
    extend(instance) {
      instance.post<{ Body: { note: string; tenantId?: string; fail?: boolean } }>(
        '/probe',
        async (request) => {
          const { note, tenantId, fail } = request.body;
          // A buggy or malicious handler naming another hospital must still be stopped.
          const result = await request.tx.execute<{ id: string; tenant_id: string }>(
            tenantId
              ? sql`insert into rls_probe (tenant_id, note) values (${tenantId}, ${note}) returning id, tenant_id`
              : sql`insert into rls_probe (tenant_id, note) values (app_tenant_id(), ${note}) returning id, tenant_id`,
          );
          if (fail) throw new Error('handler failed after writing');
          return result.rows[0];
        },
      );
      instance.get('/probe', async (request) => {
        const result = await request.tx.execute<{ note: string; tenant_id: string }>(
          sql`select note, tenant_id from rls_probe order by note`,
        );
        return { tenant: request.tenant?.id, rows: result.rows };
      });
      instance.patch<{ Body: { note: string } }>('/probe/all', async (request) => {
        const result = await request.tx.execute(
          sql`update rls_probe set note = ${request.body.note}`,
        );
        return { updated: result.rowCount };
      });
      instance.delete('/probe/all', async (request) => {
        const result = await request.tx.execute(sql`delete from rls_probe`);
        return { deleted: result.rowCount };
      });
    },
  });
  pool = app.database.pool;

  await pool.query('drop table if exists rls_probe');
  await pool.query(`
    create table rls_probe (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants (id) on delete cascade,
      note text not null
    )`);
  await pool.query('create index rls_probe_tenant on rls_probe (tenant_id, note)');
  await pool.query("select enable_tenant_rls('rls_probe')");

  hospital = await createTenant(pool, 'Isolation Hospital', {
    features: { laboratory: true, pharmacy: true },
  });
  clinic = await createTenant(pool, 'Isolation Clinic', {
    locale: 'en-GB',
    timezone: 'Asia/Dubai',
    currency: 'AED',
    themePrimary: '#4338ca',
    features: { laboratory: false },
  });
  suspended = await createTenant(pool, 'Isolation Suspended', { status: 'suspended' });

  // Rows owned by each hospital, inserted through the owner connection.
  await pool.query('insert into rls_probe (tenant_id, note) values ($1, $2), ($1, $3), ($4, $5)', [
    hospital.id,
    'hospital-1',
    'hospital-2',
    clinic.id,
    'clinic-1',
  ]);
});

afterAll(async () => {
  await deleteTenants(pool, [hospital, clinic, suspended]);
  await pool.query('drop table if exists rls_probe');
  await app.close();
});

/** What is really in the table, read through the owner connection. */
const allProbeRows = async () =>
  (
    await pool.query<{ note: string; tenant_id: string }>(
      'select note, tenant_id from rls_probe where tenant_id = any($1::uuid[]) order by note',
      [[hospital.id, clinic.id, suspended.id]],
    )
  ).rows;

describe('SQL under the app role', () => {
  describe('reads', () => {
    it('sees only its own hospital’s rows', async () => {
      const notes = await asTenantSql(pool, hospital.id, async (client) =>
        (await client.query('select note from rls_probe order by note')).rows.map((r) => r.note),
      );
      expect(notes).toEqual(['hospital-1', 'hospital-2']);

      const clinicNotes = await asTenantSql(pool, clinic.id, async (client) =>
        (await client.query('select note from rls_probe')).rows.map((r) => r.note),
      );
      expect(clinicNotes).toEqual(['clinic-1']);
    });

    it('cannot reach another hospital’s rows by naming them', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        const byTenant = await client.query('select * from rls_probe where tenant_id = $1', [
          clinic.id,
        ]);
        expect(byTenant.rows).toEqual([]);
        const byNote = await client.query("select * from rls_probe where note = 'clinic-1'");
        expect(byNote.rows).toEqual([]);
        const count = await client.query('select count(*)::int as n from rls_probe');
        expect(count.rows[0].n).toBe(2);
      });
    });

    it('sees only its own row in tenants', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        const { rows } = await client.query('select id, name from tenants');
        expect(rows).toEqual([{ id: hospital.id, name: 'Isolation Hospital' }]);
        const other = await client.query('select * from tenants where id = $1', [clinic.id]);
        expect(other.rows).toEqual([]);
      });
    });

    it('sees only its own feature flags', async () => {
      await asTenantSql(pool, clinic.id, async (client) => {
        const { rows } = await client.query(
          'select tenant_id, feature, enabled from tenant_features order by feature',
        );
        expect(rows).toEqual([{ tenant_id: clinic.id, feature: 'laboratory', enabled: false }]);
      });
    });

    it('sees nothing at all when no tenant is set', async () => {
      await asTenantSql(pool, null, async (client) => {
        expect((await client.query('select * from rls_probe')).rows).toEqual([]);
        expect((await client.query('select * from tenants')).rows).toEqual([]);
        expect((await client.query('select * from tenant_features')).rows).toEqual([]);
      });
    });
  });

  describe('writes', () => {
    it('can insert for its own hospital', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        const { rows } = await client.query(
          "insert into rls_probe (tenant_id, note) values ($1, 'own') returning tenant_id",
          [hospital.id],
        );
        expect(rows[0].tenant_id).toBe(hospital.id);
      });
    });

    it('cannot insert a row for another hospital', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        await expect(
          client.query("insert into rls_probe (tenant_id, note) values ($1, 'planted')", [
            clinic.id,
          ]),
        ).rejects.toThrow(RLS_VIOLATION);
      });
    });

    it('cannot hand one of its own rows to another hospital', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        await expect(
          client.query("update rls_probe set tenant_id = $1 where note = 'hospital-1'", [
            clinic.id,
          ]),
        ).rejects.toThrow(RLS_VIOLATION);
      });
    });

    it('cannot update or delete another hospital’s rows: they are not there to it', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        const updated = await client.query(
          "update rls_probe set note = 'defaced' where tenant_id = $1",
          [clinic.id],
        );
        expect(updated.rowCount).toBe(0);
        const deleted = await client.query('delete from rls_probe where tenant_id = $1', [
          clinic.id,
        ]);
        expect(deleted.rowCount).toBe(0);
        // An unqualified statement touches only its own rows.
        const all = await client.query("update rls_probe set note = note || '!'");
        expect(all.rowCount).toBe(2);
      });
      // asTenantSql rolls back, and the clinic's row was never touched in any case.
      expect(await allProbeRows()).toContainEqual({ note: 'clinic-1', tenant_id: clinic.id });
    });

    it('cannot write anything when no tenant is set', async () => {
      await asTenantSql(pool, null, async (client) => {
        await expect(
          client.query("insert into rls_probe (tenant_id, note) values ($1, 'x')", [hospital.id]),
        ).rejects.toThrow(RLS_VIOLATION);
      });
    });

    it.each([
      [
        'create a hospital',
        "insert into tenants (slug, name, locale, timezone, currency, theme_primary) values ('x', 'X', 'en', 'UTC', 'USD', '#000000')",
      ],
      ['rename its own hospital', "update tenants set name = 'Renamed'"],
      ['reactivate or suspend a hospital', "update tenants set status = 'active'"],
      ['delete a hospital', 'delete from tenants'],
      ['switch a module on for itself', 'update tenant_features set enabled = true'],
      [
        'add a module flag',
        "insert into tenant_features (tenant_id, feature, enabled) select app_tenant_id(), 'billing', true",
      ],
      ['remove the row-level security policy', 'drop policy tenant_isolation on rls_probe'],
      [
        'turn row-level security off for the table',
        'alter table rls_probe disable row level security',
      ],
      ['drop the table', 'drop table rls_probe'],
    ])('cannot %s', async (_what, statement) => {
      await asTenantSql(pool, hospital.id, async (client) => {
        await expect(client.query(statement)).rejects.toThrow(
          /permission denied|must be owner|row-level security/,
        );
      });
    });
  });

  describe('the app role itself', () => {
    it('is not a superuser and cannot bypass row-level security', async () => {
      const { rows } = await pool.query(
        "select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb from pg_roles where rolname = 'mediflow_app'",
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolcreatedb: false,
        },
      ]);
    });

    it('cannot switch row-level security off for its session', async () => {
      await asTenantSql(pool, hospital.id, async (client) => {
        await client.query('set local row_security = off');
        // With row_security off, a role that cannot bypass it gets an error, not the rows.
        await expect(client.query('select * from rls_probe')).rejects.toThrow(
          /row-level security policy/,
        );
      });
    });

    it('cannot change which hospital it is by forging a different tenant mid-transaction and keep prior access', async () => {
      // The setting is what the policies read, so the hook is the only thing that may set it.
      // This documents the property the hook relies on: whatever it is set to is what is seen.
      await asTenantSql(pool, hospital.id, async (client) => {
        await client.query("select set_config('app.tenant_id', $1, true)", [clinic.id]);
        const notes = (await client.query('select note from rls_probe')).rows.map((r) => r.note);
        expect(notes).toEqual(['clinic-1']);
      });
    });
  });
});

describe('the row-level security template', () => {
  it('covers every table that has a tenant_id column', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      policies: string[];
      tenant_first_index: boolean;
    }>(`
      select c.relname as table_name,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             coalesce(array(select polname::text from pg_policy where polrelid = c.oid), '{}') as policies,
             exists (
               select from pg_index i
               join pg_attribute ia on ia.attrelid = i.indrelid and ia.attnum = i.indkey[0]
               where i.indrelid = c.oid and ia.attname = 'tenant_id'
             ) as tenant_first_index
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where c.relkind = 'r'
      order by 1`);

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['rls_probe', 'tenant_features']),
    );
    for (const row of rows) {
      expect(row, row.table_name).toMatchObject({
        enabled: true,
        forced: true,
        policies: ['tenant_isolation'],
        tenant_first_index: true,
      });
    }
  });

  it('protects the tenants table too', async () => {
    const { rows } = await pool.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'tenants' and relnamespace = 'public'::regnamespace",
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('refuses a table with no tenant_id column', async () => {
    await pool.query('create table rls_bad_no_column (id uuid primary key)');
    try {
      await expect(pool.query("select enable_tenant_rls('rls_bad_no_column')")).rejects.toThrow(
        /needs a "tenant_id uuid NOT NULL" column/,
      );
    } finally {
      await pool.query('drop table rls_bad_no_column');
    }
  });

  it('refuses a nullable tenant_id, which would let rows belong to nobody', async () => {
    await pool.query('create table rls_bad_nullable (id uuid primary key, tenant_id uuid)');
    try {
      await expect(pool.query("select enable_tenant_rls('rls_bad_nullable')")).rejects.toThrow(
        /needs a "tenant_id uuid NOT NULL" column/,
      );
    } finally {
      await pool.query('drop table rls_bad_nullable');
    }
  });

  it('refuses a table with no index that starts with tenant_id', async () => {
    await pool.query(
      'create table rls_bad_no_index (id uuid primary key, tenant_id uuid not null)',
    );
    try {
      await expect(pool.query("select enable_tenant_rls('rls_bad_no_index')")).rejects.toThrow(
        /needs an index that starts with tenant_id/,
      );
    } finally {
      await pool.query('drop table rls_bad_no_index');
    }
  });
});

describe('through the API', () => {
  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  describe('GET /tenant', () => {
    it('returns the hospital of the session, with its own configuration', async () => {
      const response = await get('/tenant', as(hospital.id));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: hospital.id,
        slug: hospital.slug,
        name: 'Isolation Hospital',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        theme: { primary: '#0f766e' },
        features: { laboratory: true, pharmacy: true },
        auth: { mode: 'password' },
        status: 'active',
      });

      const other = await get('/tenant', as(clinic.id));
      expect(other.json()).toMatchObject({
        id: clinic.id,
        name: 'Isolation Clinic',
        currency: 'AED',
        timezone: 'Asia/Dubai',
        theme: { primary: '#4338ca' },
        features: { laboratory: false },
      });
      expect(other.body).not.toContain(hospital.id);
      expect(other.body).not.toContain('Isolation Hospital');
    });

    it('takes the tenant from the session, never from the request', async () => {
      // Every client-controlled place a tenant could be smuggled in. None changes the answer.
      const response = await app.inject({
        method: 'GET',
        url: `/tenant?tenantId=${clinic.id}&tenant_id=${clinic.id}`,
        headers: { ...as(hospital.id), 'x-tenant': clinic.id, tenant: clinic.id },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(hospital.id);
    });
  });

  describe('who may call a tenant route', () => {
    it('answers 401 with no session', async () => {
      const response = await get('/tenant', {});
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    });

    it('answers 409 when the user has not picked a hospital', async () => {
      const response = await get('/tenant', as(null));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'no_active_tenant' } });
    });

    it('rejects a tenant header that disagrees with the session, and accepts one that agrees', async () => {
      const stale = await get('/tenant', { ...as(hospital.id), 'x-tenant-id': clinic.id });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'tenant_mismatch' } });
      // The header is a check, not a selector: it did not get the clinic's data.
      expect(stale.body).not.toContain('Isolation Clinic');

      const fresh = await get('/tenant', { ...as(hospital.id), 'x-tenant-id': hospital.id });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().id).toBe(hospital.id);
    });

    it('answers 403 for a suspended hospital', async () => {
      const response = await get('/tenant', as(suspended.id));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'tenant_suspended' } });
    });

    it.each([
      ['a hospital that does not exist', '00000000-0000-4000-8000-000000000000'],
      ['a value that is not an id', "x'; drop table tenants; --"],
    ])('answers 409 for %s', async (_what, tenantId) => {
      const response = await get('/tenant', as(tenantId));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'no_active_tenant' } });
    });

    it('leaves public routes open and unknown routes a plain 404', async () => {
      expect((await get('/health', {})).statusCode).toBe(200);
      expect((await get('/no/such/route', {})).statusCode).toBe(404);
    });

    it('closes a route that does not declare its access', async () => {
      // /probe was registered with no `access` config at all.
      expect((await get('/probe', {})).statusCode).toBe(401);
    });
  });

  describe('reads and writes', () => {
    it('reads only the session hospital’s rows', async () => {
      const mine = (await get('/probe', as(hospital.id))).json();
      expect(mine.tenant).toBe(hospital.id);
      expect(mine.rows.map((row: { note: string }) => row.note)).toEqual(
        expect.arrayContaining(['hospital-1', 'hospital-2']),
      );
      expect(JSON.stringify(mine)).not.toContain('clinic-1');
      expect(JSON.stringify(mine)).not.toContain(clinic.id);
    });

    it('writes for the session hospital and commits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: as(clinic.id),
        payload: { note: 'clinic-via-api' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().tenant_id).toBe(clinic.id);
      expect(await allProbeRows()).toContainEqual({ note: 'clinic-via-api', tenant_id: clinic.id });
    });

    it('refuses a write that names another hospital, and stores nothing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: as(hospital.id),
        payload: { note: 'planted-via-api', tenantId: clinic.id },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
      // The database's own message, which names the table and policy, is not passed on.
      expect(response.body).not.toMatch(/rls_probe|policy/);
      expect((await allProbeRows()).map((row) => row.note)).not.toContain('planted-via-api');
    });

    it('cannot update or delete another hospital’s rows', async () => {
      const before = (await allProbeRows()).filter((row) => row.tenant_id === clinic.id);

      const updated = await app.inject({
        method: 'PATCH',
        url: '/probe/all',
        headers: as(hospital.id),
        payload: { note: 'overwritten' },
      });
      // "All rows" means all of its own rows.
      expect(updated.json().updated).toBeGreaterThanOrEqual(2);
      expect((await allProbeRows()).filter((row) => row.tenant_id === clinic.id)).toEqual(before);

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/probe/all',
        headers: as(hospital.id),
      });
      expect(deleted.json().deleted).toBeGreaterThanOrEqual(2);
      const remaining = await allProbeRows();
      expect(remaining.filter((row) => row.tenant_id === hospital.id)).toEqual([]);
      expect(remaining.filter((row) => row.tenant_id === clinic.id)).toEqual(before);
    });

    it('rolls back everything a handler wrote when the handler then fails', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: as(clinic.id),
        payload: { note: 'half-done', fail: true },
      });
      expect(response.statusCode).toBe(500);
      expect((await allProbeRows()).map((row) => row.note)).not.toContain('half-done');
    });
  });

  describe('connections', () => {
    it('never carries one request’s hospital over to the next on a pooled connection', async () => {
      // Many interleaved requests for two hospitals share a few connections.
      const requests = Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0 ? hospital : clinic,
      );
      const responses = await Promise.all(requests.map((tenant) => get('/tenant', as(tenant.id))));
      responses.forEach((response, index) => {
        expect(response.statusCode).toBe(200);
        expect(response.json().id).toBe(requests[index]?.id);
      });
    });

    it('returns every connection to the pool, whatever the outcome', async () => {
      const outcomes = [
        () => get('/tenant', as(hospital.id)),
        () => get('/tenant', as(suspended.id)),
        () => get('/tenant', { ...as(hospital.id), 'x-tenant-id': clinic.id }),
        () =>
          app.inject({
            method: 'POST',
            url: '/probe',
            headers: as(hospital.id),
            payload: { note: 'x', tenantId: clinic.id },
          }),
        () =>
          app.inject({
            method: 'POST',
            url: '/probe',
            headers: as(clinic.id),
            payload: { note: 'y', fail: true },
          }),
      ];
      // More requests than the pool has connections: a leak would make these hang and time out.
      for (let round = 0; round < 6; round++) {
        await Promise.all(outcomes.map((request) => request()));
      }
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
    });

    it('leaves a pooled connection with no role and no tenant after a request', async () => {
      await get('/tenant', as(hospital.id));
      const { rows } = await pool.query(
        "select current_user = session_user as role_reset, current_setting('app.tenant_id', true) as tenant",
      );
      expect(rows[0].role_reset).toBe(true);
      expect(rows[0].tenant ?? '').toBe('');
    });
  });
});
