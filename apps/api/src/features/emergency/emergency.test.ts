import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * The emergency API through the real app and database: registration with temporary IDs, triage,
 * linking to a patient and undoing the link, the board's order and paging, the hospital boundary,
 * permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let patientId: string;
let otherPatientId: string;
let clinicPatientId: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Case {
  id: string;
  tempId: string;
  patientId?: string;
  category?: number;
  status: string;
  complaint: string;
  version: number;
  identifiedAt?: string;
}
interface Page {
  items: Case[];
  nextCursor: string | null;
  total?: number;
}

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `er-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}
const register = (body: object, options: Options = {}) =>
  post('/emergency/cases', { complaint: 'Chest pain', arrivalMode: 'walk_in', ...body }, options);

const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows;
const audited = async (entityId: string) =>
  (
    await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'er_case' and entity_id = $2 order by at",
      [hospital.id, entityId],
    )
  ).rows.map((row) => row.action);

/** Test set-up that the guards would refuse: runs with triggers off. */
async function bypass(sql: string, params: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(sql, params);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of ['er_case_links', 'er_encounters', 'er_counters']) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('delete from outbox where tenant_id = any($1)', [tenants()]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'ER Hospital', {
    features: { emergency: true, patients: true },
  });
  clinic = await createTenant(pool, 'ER Clinic', { features: { emergency: true, patients: true } });
  closed = await createTenant(pool, 'ER Closed', { features: { emergency: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'ER Admin', { withPassword: false });
  doctor = await createUser(pool, 'ER Doctor', { withPassword: false });
  pharmacist = await createUser(pool, 'ER Pharmacist', { withPassword: false });
  clinicAdmin = await createUser(pool, 'ER Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const patient = async (tenant: TestTenant, mrn: string) =>
    (
      (
        await pool.query<{ id: string }>(
          `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
           values ($1, $2, 'Er', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
          [tenant.id, mrn],
        )
      ).rows[0] as { id: string }
    ).id;
  patientId = await patient(hospital, 'ER-0000001');
  otherPatientId = await patient(hospital, 'ER-0000002');
  clinicPatientId = await patient(clinic, 'ER-0000003');
});

afterAll(async () => {
  try {
    await wipe();
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(pool, [admin, doctor, pharmacist, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('registration', () => {
  it('numbers unidentified arrivals per hospital and keeps the temporary ID', async () => {
    await wipe();
    const first = await ok<Case>(await register({ alias: 'Man in blue jacket' }), 201);
    const second = await ok<Case>(await register({ complaint: 'Road accident' }), 201);
    expect([first.tempId, second.tempId]).toEqual(['ER-0001', 'ER-0002']);
    expect(first.patientId).toBeUndefined();
    expect(first.category).toBeUndefined();
    expect(first.status).toBe('waiting');
    const clinicCase = await ok<Case>(
      await register({}, { tenant: clinic, user: clinicAdmin }),
      201,
    );
    expect(clinicCase.tempId).toBe('ER-0001');
    expect(await audited(first.id)).toEqual(['create']);
    expect((await eventsOf(first.id)).map((row) => row.event)).toEqual(['er.registered']);
  });

  it('registers for a patient on record and triages at once', async () => {
    const made = await ok<Case>(await register({ patientId, category: 2 }), 201);
    expect(made.patientId).toBe(patientId);
    expect(made.category).toBe(2);
    const events = await eventsOf(made.id);
    expect(events.map((row) => row.event)).toEqual(['er.registered', 'er.triaged']);
    expect(JSON.stringify(events)).not.toContain('Chest pain');
  });

  it('refuses a patient of another hospital, a bad body and a missing key', async () => {
    expect(errorOf(await register({ patientId: clinicPatientId }))).toEqual([
      404,
      'unknown_patient',
    ]);
    expect(errorOf(await register({ patientId: 'nope' }))).toEqual([404, 'unknown_patient']);
    expect((await register({ category: 6 })).statusCode).toBe(400);
    expect((await register({ complaint: '' })).statusCode).toBe(400);
    const noKey = await app.inject({
      method: 'POST',
      url: '/emergency/cases',
      headers: headers(),
      payload: { complaint: 'x', arrivalMode: 'walk_in' },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it('repeats an Idempotency-Key without a second case', async () => {
    const key = fresh();
    const one = await ok<Case>(await register({ complaint: 'Fall' }, { key }), 201);
    const two = await ok<Case>(await register({ complaint: 'Fall' }, { key }), 201);
    expect(two.id).toBe(one.id);
    expect(two.complaint).toBe('Fall');
    expect(errorOf(await register({ complaint: 'Something else' }, { key }))).toEqual([
      422,
      expect.any(String),
    ]);
  });
});

describe('triage', () => {
  it('sets and changes the category at the version read', async () => {
    const made = await ok<Case>(await register({}), 201);
    const triaged = await ok<Case>(
      await post(`/emergency/cases/${made.id}/triage`, { category: 3, version: made.version }),
    );
    expect(triaged.category).toBe(3);
    expect(triaged.version).toBe(made.version + 1);
    expect(
      errorOf(
        await post(`/emergency/cases/${made.id}/triage`, { category: 1, version: made.version }),
      ),
    ).toEqual([409, 'version_conflict']);
    const changed = await ok<Case>(
      await post(
        `/emergency/cases/${made.id}/triage`,
        { category: 1, version: triaged.version },
        {
          user: doctor,
        },
      ),
    );
    expect(changed.category).toBe(1);
    const events = await eventsOf(made.id);
    expect(events.filter((row) => row.event === 'er.triaged').map((row) => row.payload)).toEqual([
      expect.objectContaining({ category: 3, previous: null }),
      expect.objectContaining({ category: 1, previous: 3 }),
    ]);
    expect(await audited(made.id)).toEqual(['create', 'update', 'update']);
  });

  it('refuses a case that has left, an unknown case and a caller without the permission', async () => {
    const made = await ok<Case>(await register({}), 201);
    await bypass("update er_encounters set status = 'disposed' where id = $1 and tenant_id = $2", [
      made.id,
      hospital.id,
    ]);
    expect(
      errorOf(await post(`/emergency/cases/${made.id}/triage`, { category: 2, version: 1 })),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(
        await post('/emergency/cases/00000000-0000-4000-8000-000000000000/triage', {
          category: 2,
          version: 1,
        }),
      ),
    ).toEqual([404, 'case_not_found']);
    expect(
      (
        await post(
          `/emergency/cases/${made.id}/triage`,
          { category: 2, version: 1 },
          {
            user: pharmacist,
          },
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('identify and undo', () => {
  it('links once, keeps the temporary ID and can be undone within the window', async () => {
    const made = await ok<Case>(await register({ alias: 'Unknown woman' }), 201);
    const linked = await ok<Case>(
      await post(`/emergency/cases/${made.id}/identify`, { patientId, version: made.version }),
    );
    expect(linked.patientId).toBe(patientId);
    expect(linked.tempId).toBe(made.tempId);
    expect(linked.identifiedAt).toBeTruthy();
    expect(
      errorOf(
        await post(`/emergency/cases/${made.id}/identify`, {
          patientId: otherPatientId,
          version: linked.version,
        }),
      ),
    ).toEqual([409, 'already_identified']);
    expect(
      errorOf(
        await post(`/emergency/cases/${made.id}/unidentify`, {
          version: linked.version - 1,
          reason: 'Wrong person',
        }),
      ),
    ).toEqual([409, 'version_conflict']);
    const undone = await ok<Case>(
      await post(`/emergency/cases/${made.id}/unidentify`, {
        version: linked.version,
        reason: 'Wrong person',
      }),
    );
    expect(undone.patientId).toBeUndefined();
    expect(undone.identifiedAt).toBeUndefined();
    expect(undone.tempId).toBe(made.tempId);
    const relinked = await ok<Case>(
      await post(`/emergency/cases/${made.id}/identify`, {
        patientId: otherPatientId,
        version: undone.version,
      }),
    );
    expect(relinked.patientId).toBe(otherPatientId);
    const links = (
      await pool.query<{
        patient_id: string;
        undone_by: string | null;
        undo_reason: string | null;
      }>(
        'select patient_id, undone_by, undo_reason from er_case_links where case_id = $1 order by linked_at',
        [made.id],
      )
    ).rows;
    expect(links).toEqual([
      { patient_id: patientId, undone_by: admin.id, undo_reason: 'Wrong person' },
      { patient_id: otherPatientId, undone_by: null, undo_reason: null },
    ]);
    expect((await eventsOf(made.id)).map((row) => row.event)).toEqual([
      'er.registered',
      'er.identified',
      'er.unidentified',
      'er.identified',
    ]);
    expect(await audited(made.id)).toEqual(['create', 'update', 'update', 'update']);
  });

  it('closes the window after a day and never undoes a registration with a patient', async () => {
    const made = await ok<Case>(await register({}), 201);
    const linked = await ok<Case>(
      await post(`/emergency/cases/${made.id}/identify`, { patientId, version: made.version }),
    );
    await bypass(
      "update er_case_links set linked_at = now() - interval '25 hours' where case_id = $1",
      [made.id],
    );
    expect(
      errorOf(
        await post(`/emergency/cases/${made.id}/unidentify`, {
          version: linked.version,
          reason: 'Too late',
        }),
      ),
    ).toEqual([409, 'window_closed']);
    const known = await ok<Case>(await register({ patientId }), 201);
    expect(
      errorOf(
        await post(`/emergency/cases/${known.id}/unidentify`, {
          version: known.version,
          reason: 'Why not',
        }),
      ),
    ).toEqual([409, 'not_reversible']);
  });

  it('refuses a patient of another hospital and a link row that is edited or deleted', async () => {
    const made = await ok<Case>(await register({}), 201);
    expect(
      errorOf(
        await post(`/emergency/cases/${made.id}/identify`, {
          patientId: clinicPatientId,
          version: made.version,
        }),
      ),
    ).toEqual([404, 'unknown_patient']);
    await ok<Case>(
      await post(`/emergency/cases/${made.id}/identify`, { patientId, version: made.version }),
    );
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('update er_case_links set patient_id = $1 where case_id = $2', [
          otherPatientId,
          made.id,
        ]),
      ),
    ).rejects.toThrow(/only undone|permission denied/);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('update er_encounters set complaint = $1 where id = $2', ['Changed', made.id]),
      ),
    ).rejects.toThrow(/Only the triage/);
  });
});

describe('the board', () => {
  it('orders untriaged first, then by category and wait, and pages by cursor', async () => {
    await wipe();
    const a = await ok<Case>(await register({ complaint: 'a', category: 4 }), 201);
    const b = await ok<Case>(await register({ complaint: 'b' }), 201);
    const c = await ok<Case>(await register({ complaint: 'c', category: 2 }), 201);
    const d = await ok<Case>(await register({ complaint: 'd', category: 4 }), 201);
    const e = await ok<Case>(await register({ complaint: 'e', category: 2 }), 201);
    const gone = await ok<Case>(await register({ complaint: 'gone' }), 201);
    await bypass("update er_encounters set status = 'disposed' where id = $1", [gone.id]);
    await bypass("update er_encounters set arrived_at = now() - interval '1 hour' where id = $1", [
      d.id,
    ]);

    const all = await ok<Page>(await get('/emergency/cases'));
    expect(all.items.map((row) => row.id)).toEqual([b.id, c.id, e.id, d.id, a.id]);
    expect(all.total).toBe(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await ok<Page>(
        await get(`/emergency/cases?limit=2${cursor ? `&cursor=${cursor}` : ''}`),
      );
      if (cursor) expect(page.total).toBeUndefined();
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([b.id, c.id, e.id, d.id, a.id]);

    const closedOnes = await ok<Page>(await get('/emergency/cases?status=disposed'));
    expect(closedOnes.items.map((row) => row.id)).toEqual([gone.id]);
    expect(errorOf(await get('/emergency/cases?cursor=garbage'))).toEqual([400, 'invalid_cursor']);
    expect(await audited(b.id)).toContain('read');
  });
});

describe('the hospital boundary and permissions', () => {
  it('shows one hospital only its own cases', async () => {
    const mine = await ok<Case>(await register({ complaint: 'private' }), 201);
    const other = await ok<Page>(
      await get('/emergency/cases', { tenant: clinic, user: clinicAdmin }),
    );
    expect(other.items.map((row) => row.id)).not.toContain(mine.id);
    expect(
      (
        await post(
          `/emergency/cases/${mine.id}/triage`,
          { category: 1, version: 1 },
          {
            tenant: clinic,
            user: clinicAdmin,
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/emergency/cases/${mine.id}/identify`,
          { patientId: clinicPatientId, version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    const rows = await asTenantSql(pool, clinic.id, (client) =>
      client.query('select id from er_encounters where id = $1', [mine.id]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('is off when the hospital switch is off and without the permission', async () => {
    expect(errorOf(await get('/emergency/cases', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect((await get('/emergency/cases', { user: pharmacist })).statusCode).toBe(403);
    expect((await get('/emergency/cases', { user: doctor })).statusCode).toBe(200);
    expect((await register({}, { user: doctor })).statusCode).toBe(403);
  });
});
