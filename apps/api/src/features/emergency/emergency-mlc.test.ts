import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
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

/**
 * Medico-legal records (ER-03, #173) through the real app and database: flagging a case, revisions
 * that never overwrite, required fields, restricted access, audit on every view and the hospital
 * boundary.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let nurse: TestUser;
let clinicAdmin: TestUser;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Case {
  id: string;
  medicoLegal: boolean;
}
interface Mlc {
  revision: number;
  category: string;
  narrative: string;
  policeInformed: boolean;
  policeStation?: string;
  recordedByName: string;
}

let keys = 0;
const fresh = () => `er-mlc-${String(++keys).padStart(6, '0')}`;
const headers = ({ tenant = hospital, user = admin }: Options = {}, key?: string) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const arrive = async (options: Options = {}) => {
  const response = await app.inject({
    method: 'POST',
    url: '/emergency/cases',
    headers: headers(options, fresh()),
    payload: { complaint: 'Road accident', arrivalMode: 'police' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Case>();
};
const save = (caseId: string, body: object, options: Options = {}, key = fresh()) =>
  app.inject({
    method: 'PUT',
    url: `/emergency/cases/${caseId}/medico-legal`,
    headers: headers(options, key),
    payload: {
      revision: 0,
      category: 'road_accident',
      narrative: 'Two-wheeler hit by a truck; head injury and a fracture of the left arm.',
      policeInformed: true,
      policeStation: 'Central police station',
      ...body,
    },
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
const tenants = () => [hospital, clinic].map((tenant) => tenant.id);

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'MLC Hospital', { features: { emergency: true } });
  clinic = await createTenant(pool, 'MLC Clinic', { features: { emergency: true } });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'MLC Admin', { withPassword: false });
  doctor = await createUser(pool, 'MLC Doctor', { withPassword: false });
  nurse = await createUser(pool, 'MLC Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'MLC Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
});

afterAll(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      for (const table of ['er_medico_legal', 'er_encounters', 'er_counters', 'outbox']) {
        await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
      }
      await client.query('commit');
    } finally {
      client.release();
    }
    await deleteUsers(pool, [admin, doctor, nurse, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('flagging a case', () => {
  it('flags it, shows the flag on the case and keeps the record', async () => {
    const row = await arrive();
    expect(row.medicoLegal).toBe(false);
    expect((await get(`/emergency/cases/${row.id}/medico-legal`)).statusCode).toBe(404);

    const response = await save(row.id, {}, { user: doctor });
    expect(response.statusCode).toBe(200);
    expect(response.json<Mlc>()).toMatchObject({
      revision: 1,
      category: 'road_accident',
      policeStation: 'Central police station',
      recordedByName: 'MLC Doctor',
    });

    const one = await get(`/emergency/cases/${row.id}`, { user: nurse });
    expect(one.json<Case>().medicoLegal).toBe(true);
    const board = (await get('/emergency/cases', { user: nurse })).json<{ items: Case[] }>();
    expect(board.items.find((item) => item.id === row.id)?.medicoLegal).toBe(true);
  });

  it('keeps every revision and refuses a stale one', async () => {
    const row = await arrive();
    await save(row.id, {});
    const second = await save(row.id, { revision: 1, category: 'assault' });
    expect(second.json<Mlc>()).toMatchObject({ revision: 2, category: 'assault' });
    expect(errorOf(await save(row.id, { revision: 1 }))).toEqual([409, 'version_conflict']);
    expect(errorOf(await save(row.id, { revision: 0 }))).toEqual([409, 'version_conflict']);
    const { rows } = await pool.query<{ revision: number }>(
      'select revision from er_medico_legal where case_id = $1 order by revision',
      [row.id],
    );
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
  });

  it('repeats an identical request without a second revision', async () => {
    const row = await arrive();
    const key = fresh();
    await save(row.id, {}, {}, key);
    const again = await save(row.id, {}, {}, key);
    expect(again.statusCode).toBe(200);
    expect(again.json<Mlc>().revision).toBe(1);
  });

  it('needs the police station when the police are informed', async () => {
    const row = await arrive();
    const response = await save(row.id, { policeStation: undefined });
    expect(errorOf(response)).toEqual([422, 'police_station_required']);
    const quiet = await save(row.id, { policeInformed: false, policeStation: undefined });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json<Mlc>().policeInformed).toBe(false);
  });

  it('requires the category and the account of the injury', async () => {
    const row = await arrive();
    expect((await save(row.id, { narrative: '' })).statusCode).toBe(400);
    expect((await save(row.id, { category: 'nonsense' })).statusCode).toBe(400);
    expect((await save(row.id, { narrative: undefined })).statusCode).toBe(400);
  });
});

describe('restricted access and audit', () => {
  it('refuses a nurse the details and the flagging', async () => {
    const row = await arrive();
    await save(row.id, {});
    const view = await get(`/emergency/cases/${row.id}/medico-legal`, { user: nurse });
    expect(errorOf(view)).toEqual([403, 'permission_denied']);
    expect(errorOf(await save(row.id, { revision: 1 }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('audits every view, also a repeat, and every save', async () => {
    const row = await arrive();
    await save(row.id, {});
    await get(`/emergency/cases/${row.id}/medico-legal`, { user: doctor });
    await get(`/emergency/cases/${row.id}/medico-legal`, { user: doctor });
    const { rows } = await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'er_medico_legal' and entity_id = $2 order by at, id",
      [hospital.id, row.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['create', 'read', 'read']);
    const events = await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from outbox where tenant_id = $1 and entity_id = $2 and event = 'er.medico_legal'",
      [hospital.id, row.id],
    );
    expect(events.rows[0]?.payload).not.toHaveProperty('narrative');
  });
});

describe('hospital boundary', () => {
  it('does not show a case or its record to another hospital', async () => {
    const row = await arrive();
    await save(row.id, {});
    const other = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(`/emergency/cases/${row.id}/medico-legal`, other))).toEqual([
      404,
      'case_not_found',
    ]);
    expect(errorOf(await save(row.id, { revision: 1 }, other))).toEqual([404, 'case_not_found']);
    const { rows } = await pool.query(
      'select 1 from er_medico_legal where case_id = $1 and tenant_id = $2',
      [row.id, clinic.id],
    );
    expect(rows).toHaveLength(0);
  });
});
