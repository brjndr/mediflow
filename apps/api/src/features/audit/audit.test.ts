import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestFileStore, type TestFileStore } from '../../../test/file-store.js';
import {
  addMembership,
  as,
  asTenantSql,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  grantRoleDefaults,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../../core/jobs/queue.js';

/**
 * The hospital's own audit log (#1066): the search, its filters and range, the permission and the
 * switch, the hospital boundary, the read being audited, and the stored `audit_log` report.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let files: TestFileStore;
const queue = new MemoryQueue();
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;
let desk: TestUser;
let day: string;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const errorCode = (response: Response) => response.json<{ error: { code: string } }>().error.code;

const search = (body: object, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url: '/audit/search',
    headers: as(tenant.id, user.id),
    payload: body,
  });
const createRun = (body: object, key: string, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url: '/reports/audit_log/runs',
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    payload: body,
  });
const get = (url: string, tenant = hospital, user = admin) =>
  app.inject({ url, headers: as(tenant.id, user.id) });

interface Entry {
  id: string;
  at: string;
  actor: { id: string; name: string } | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail: string | null;
}
type Page = { items: Entry[]; nextCursor: string | null };

/** Plants rows at midday UTC of `day` (the same calendar day at any hospital clock we use). */
async function plantAudit(
  tenant: TestTenant,
  rows: [hour: number, actor: string | null, action: string, entity: string, id: string | null][],
): Promise<void> {
  for (const [hour, actor, action, entity, entityId] of rows) {
    await pool.query(
      `insert into audit_log (tenant_id, at, actor_id, action, entity, entity_id, detail)
       values ($1, ($2::date + make_interval(hours => $3)) at time zone 'UTC', $4, $5, $6, $7, 'rev:1')`,
      [tenant.id, day, hour, actor, action, entity, entityId],
    );
  }
}

beforeAll(async () => {
  files = await makeTestFileStore('audit');
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: queue,
    fileStore: files.store,
  });
  pool = app.database.pool;
  const { rows } = await pool.query<{ day: string }>(
    "select (now() at time zone 'UTC' - interval '1 day')::date::text as day",
  );
  day = rows[0]?.day ?? '';
  const on = { audit_log: true, reports: true };
  hospital = await createTenant(pool, 'Audit Hospital', { features: on });
  clinic = await createTenant(pool, 'Audit Clinic', { features: on });
  closed = await createTenant(pool, 'Audit Closed', { features: { audit_log: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Audit Admin');
  clinicAdmin = await createUser(pool, 'Clinic Auditor');
  desk = await createUser(pool, 'Audit Desk');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await plantAudit(hospital, [
    [8, admin.id, 'read', 'patient', 'p-1'],
    [9, admin.id, 'update', 'patient', 'p-1'],
    [10, desk.id, 'read', 'patient', 'p-2'],
    [11, null, 'create', 'invoice', 'i-1'],
  ]);
  await plantAudit(clinic, [[9, clinicAdmin.id, 'read', 'patient', 'p-1']]);
});

afterAll(async () => {
  await pool.query('delete from report_runs where tenant_id = any($1::uuid[])', [
    [hospital.id, clinic.id, closed.id],
  ]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await deleteUsers(pool, [admin, clinicAdmin, desk]);
  await app.close();
  await files.cleanup();
});

describe('the audit search', () => {
  it('lists the hospital’s entries newest first with the actor’s name, and nothing of another', async () => {
    const response = await search({ from: day, to: day });
    expect(response.statusCode).toBe(200);
    const page = response.json<Page>();
    expect(page.items.map((e) => [e.action, e.entity, e.entityId])).toEqual([
      ['create', 'invoice', 'i-1'],
      ['read', 'patient', 'p-2'],
      ['update', 'patient', 'p-1'],
      ['read', 'patient', 'p-1'],
    ]);
    expect(page.items[0]?.actor).toBeNull();
    expect(page.items[1]?.actor).toEqual({ id: desk.id, name: 'Audit Desk' });
    expect(page.items[3]?.detail).toBe('rev:1');
    expect(JSON.stringify(page)).not.toContain(clinicAdmin.id);
  });

  it('pages by cursor without losing or repeating an entry', async () => {
    const first = (await search({ from: day, to: day, limit: 3 })).json<Page>();
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await search({ from: day, to: day, limit: 3, cursor: first.nextCursor })
    ).json<Page>();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect((await search({ from: day, to: day, cursor: 'nonsense' })).statusCode).toBe(400);
  });

  it('filters by actor, kind of record, record and action', async () => {
    const by = async (filter: object) =>
      (await search({ from: day, to: day, ...filter })).json<Page>().items.length;
    expect(await by({ actorId: admin.id })).toBe(2);
    expect(await by({ entity: 'invoice' })).toBe(1);
    expect(await by({ entityId: 'p-1' })).toBe(2);
    expect(await by({ action: 'read', entity: 'patient' })).toBe(2);
    expect(await by({ actorId: randomUUID() })).toBe(0);
  });

  it('finds free text in the action or the kind of record, with % and _ taken literally', async () => {
    const by = async (q: string) =>
      (await search({ from: day, to: day, q })).json<Page>().items.length;
    expect(await by('INVOIC')).toBe(1);
    expect(await by('read')).toBe(2);
    expect(await by('pat')).toBe(3);
    expect(await by('%')).toBe(0);
    expect(await by('_')).toBe(0);
    expect(await by('nothing')).toBe(0);
    expect((await search({ from: day, to: day, q: 'x'.repeat(64) })).statusCode).toBe(400);
  });

  it('needs a range of valid days, at most 92', async () => {
    expect((await search({})).statusCode).toBe(400);
    expect(errorCode(await search({ from: day, to: '2000-01-01' }))).toBe('range_invalid');
    expect((await search({ from: '2026-02-30', to: '2026-03-01' })).statusCode).toBe(400);
    expect(errorCode(await search({ from: '2026-01-01', to: '2026-04-03' }))).toBe(
      'range_too_long',
    );
    expect((await search({ from: '2026-01-01', to: '2026-04-02' })).statusCode).toBe(200);
  });

  it('is itself recorded in the audit log, by the person who looked', async () => {
    await search({ from: day, to: day });
    const { rows } = await pool.query(
      "select 1 from audit_log where tenant_id = $1 and action = 'read' and entity = 'audit_log' and actor_id = $2",
      [hospital.id, admin.id],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('is refused without the permission, with the module off, and without a session', async () => {
    const denied = await search({ from: day, to: day }, hospital, desk);
    expect([denied.statusCode, errorCode(denied)]).toEqual([403, 'permission_denied']);
    const off = await search({ from: day, to: day }, closed);
    expect([off.statusCode, errorCode(off)]).toEqual([403, 'feature_disabled']);
    const anon = await app.inject({
      method: 'POST',
      url: '/audit/search',
      payload: { from: day, to: day },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('never reaches another hospital’s entries, in the API or in the database', async () => {
    const mine = (await search({ from: day, to: day }, clinic, clinicAdmin)).json<Page>();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.actor?.name).toBe('Clinic Auditor');
    const seen = await asTenantSql(pool, hospital.id, (client) =>
      client.query('select tenant_id from audit_log where tenant_id = $1', [clinic.id]),
    );
    expect(seen.rows).toEqual([]);
    const none = await asTenantSql(pool, null, (client) => client.query('select 1 from audit_log'));
    expect(none.rows).toEqual([]);
  });

  it('gives a hospital’s admin both permissions by default', async () => {
    const { rows } = await pool.query<{ permission: string }>(
      `select permission from role_permissions
       where tenant_id = $1 and role_id = 'admin' and permission like 'auditLog:%' order by 1`,
      [hospital.id],
    );
    expect(rows.map((r) => r.permission)).toEqual(['auditLog:export', 'auditLog:read']);
    const receptionist = await pool.query(
      "select 1 from role_permissions where tenant_id = $1 and permission like 'auditLog:%' and role_id <> 'admin'",
      [hospital.id],
    );
    expect(receptionist.rows).toEqual([]);
  });
});

describe('the audit log as a stored report', () => {
  it('is made by a job and downloaded as a CSV with names, actions and record ids', async () => {
    const created = await createRun({ from: day, to: day }, 'audit-run-00001');
    expect(created.statusCode).toBe(202);
    const run = created.json<{ id: string }>();
    await queue.drain();
    const done = (await get(`/reports/runs/${run.id}`)).json<{
      status: string;
      result: { columns: { key: string }[]; rows: (string | null)[][] };
    }>();
    expect(done.status).toBe('succeeded');
    expect(done.result.columns.map((c) => c.key)).toEqual([
      'at',
      'actor',
      'action',
      'entity',
      'entityId',
      'detail',
    ]);
    expect(done.result.rows.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([
      ['Audit Admin', 'read', 'patient', 'p-1'],
      ['Audit Admin', 'update', 'patient', 'p-1'],
      ['Audit Desk', 'read', 'patient', 'p-2'],
      [null, 'create', 'invoice', 'i-1'],
    ]);
    const link = (await get(`/reports/runs/${run.id}/download-url`)).json<{ url: string }>();
    const file = await app.inject({ url: link.url });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('Audit Admin,update,patient,p-1,rev:1');
  });

  it('keeps the person, record and action filters of the request and applies them in the job', async () => {
    const make = async (body: object, key: string, tenant = hospital, user = admin) => {
      const created = await createRun({ from: day, to: day, ...body }, key, tenant, user);
      expect(created.statusCode).toBe(202);
      const run = created.json<{ id: string }>();
      await queue.drain();
      const done = (await get(`/reports/runs/${run.id}`, tenant, user)).json<{
        status: string;
        result: { rows: (string | null)[][] };
      }>();
      expect(done.status).toBe('succeeded');
      return done.result.rows.map((r) => [r[1], r[2], r[3], r[4]]);
    };
    expect(await make({ actorId: desk.id }, 'audit-run-00010')).toEqual([
      ['Audit Desk', 'read', 'patient', 'p-2'],
    ]);
    expect(await make({ entity: 'patient', action: 'read' }, 'audit-run-00011')).toEqual([
      ['Audit Admin', 'read', 'patient', 'p-1'],
      ['Audit Desk', 'read', 'patient', 'p-2'],
    ]);
    expect(await make({ entityId: 'i-1' }, 'audit-run-00012')).toEqual([
      [null, 'create', 'invoice', 'i-1'],
    ]);
    // Another hospital's row (p-1 read by its own admin) never appears in this hospital's file.
    expect(await make({ entityId: 'p-1', action: 'read' }, 'audit-run-00013')).toEqual([
      ['Audit Admin', 'read', 'patient', 'p-1'],
    ]);
    expect(await make({ entityId: 'p-1' }, 'audit-run-00014', clinic, clinicAdmin)).toEqual([
      ['Clinic Auditor', 'read', 'patient', 'p-1'],
    ]);
    // Free text matches part of the action or the record type, any case, as the search does.
    expect(await make({ q: 'INVOI' }, 'audit-run-00016')).toEqual([
      [null, 'create', 'invoice', 'i-1'],
    ]);
    expect(await make({ q: 'upd' }, 'audit-run-00017')).toEqual([
      ['Audit Admin', 'update', 'patient', 'p-1'],
    ]);
    expect(await make({ q: '%' }, 'audit-run-00018')).toEqual([]);
    // Another hospital's rows never match: the clinic's own read is the only patient read it has.
    expect(await make({ q: 'patient' }, 'audit-run-00019', clinic, clinicAdmin)).toEqual([
      ['Clinic Auditor', 'read', 'patient', 'p-1'],
    ]);
  });

  it('says what a run was filtered by, in the run view, the list and the file', async () => {
    const make = async (body: object, key: string, tenant = hospital, user = admin) => {
      const created = await createRun({ from: day, to: day, ...body }, key, tenant, user);
      expect(created.statusCode).toBe(202);
      await queue.drain();
      return created.json<{ id: string }>().id;
    };
    const filtered = await make({ actorId: desk.id, action: 'read', q: 'pat' }, 'audit-run-00020');
    const plain = await make({}, 'audit-run-00021');
    const other = await make({ entityId: 'p-1' }, 'audit-run-00022', clinic, clinicAdmin);

    const view = (await get(`/reports/runs/${filtered}`)).json<{ filters?: object }>();
    expect(view.filters).toEqual({
      actorId: desk.id,
      actorName: 'Audit Desk',
      action: 'read',
      q: 'pat',
    });
    const list = (await get('/reports/runs')).json<{ items: { id: string; filters?: object }[] }>();
    expect(list.items.find((i) => i.id === filtered)?.filters).toEqual(view.filters);
    expect(list.items.find((i) => i.id === plain)?.filters).toBeUndefined();
    expect(list.items.map((i) => i.id)).not.toContain(other);

    const file = async (id: string) => {
      const link = (await get(`/reports/runs/${id}/download-url`)).json<{ url: string }>();
      return (await app.inject({ url: link.url })).body.replace('﻿', '').split('\r\n');
    };
    const lines = await file(filtered);
    expect(lines.slice(0, 6)).toEqual([
      `from,${day}`,
      `to,${day}`,
      'person,Audit Desk',
      'action,read',
      'search,pat',
      '',
    ]);
    expect(lines[6]).toBe('at,actor,action,entity,entityId,detail');
    expect((await file(plain)).slice(0, 4)).toEqual([
      `from,${day}`,
      `to,${day}`,
      'filters,none',
      '',
    ]);
  });

  it('refuses filters on a report that has none', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reports/revenue/runs',
      headers: { ...as(hospital.id, admin.id), 'idempotency-key': 'audit-run-00015' },
      payload: { from: day, to: day, entity: 'patient' },
    });
    expect([response.statusCode, errorCode(response)]).toEqual([422, 'filters_not_supported']);
  });

  it('is not answered on the spot, and needs the module', async () => {
    const sync = await app.inject({
      method: 'POST',
      url: '/reports/audit_log',
      headers: as(hospital.id, admin.id),
      payload: { from: day, to: day },
    });
    expect([sync.statusCode, errorCode(sync)]).toEqual([422, 'stored_only']);
    const off = await createRun({ from: day, to: day }, 'audit-run-00002', closed);
    expect([off.statusCode, errorCode(off)]).toEqual([403, 'feature_disabled']);
    const denied = await createRun({ from: day, to: day }, 'audit-run-00003', hospital, desk);
    expect(denied.statusCode).toBe(403);
  });

  it('is hidden from the report list, its run and its link once the module is off', async () => {
    const created = await createRun({ from: day, to: day }, 'audit-run-00004');
    const run = created.json<{ id: string }>();
    await queue.drain();
    const ids = async () =>
      (await get('/reports/runs')).json<{ items: { id: string }[] }>().items.map((i) => i.id);
    expect(await ids()).toContain(run.id);

    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'audit_log'",
      [hospital.id],
    );
    try {
      expect(await ids()).not.toContain(run.id);
      expect((await get(`/reports/runs/${run.id}`)).statusCode).toBe(404);
      expect((await get(`/reports/runs/${run.id}/download-url`)).statusCode).toBe(404);
    } finally {
      await pool.query(
        "update tenant_features set enabled = true where tenant_id = $1 and feature = 'audit_log'",
        [hospital.id],
      );
    }
    expect((await get(`/reports/runs/${run.id}`)).statusCode).toBe(200);
  });

  it('is another hospital’s business: its admin cannot read or link a run', async () => {
    const run = (await createRun({ from: day, to: day }, 'audit-run-00005')).json<{ id: string }>();
    await queue.drain();
    expect((await get(`/reports/runs/${run.id}`, clinic, clinicAdmin)).statusCode).toBe(404);
    expect(
      (await get(`/reports/runs/${run.id}/download-url`, clinic, clinicAdmin)).statusCode,
    ).toBe(404);
  });
});
