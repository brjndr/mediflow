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
 * Emergency care and disposition (ER-02, #172) through the real app and database: starting
 * treatment, observation notes, the emergency encounter, the four dispositions and an admission
 * made from the department, with the hospital boundary, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let nurse: TestUser;
let receptionist: TestUser;
let clinicAdmin: TestUser;
let patientCount = 0;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Case {
  id: string;
  tempId: string;
  patientId?: string;
  status: string;
  version: number;
  encounterId?: string;
  disposition?: string;
  admissionId?: string;
  destination?: string;
  deathAt?: string;
}
interface Note {
  id: string;
  kind: string;
  body: string;
  authorName: string;
}
interface NotePage {
  items: Note[];
  nextCursor: string | null;
}

let keys = 0;
const fresh = () => `er-care-${String(++keys).padStart(6, '0')}`;
const headers = ({ tenant = hospital, user = admin }: Options = {}, key?: string) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}, key = fresh()) =>
  app.inject({ method: 'POST', url, headers: headers(options, key), payload: body });
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

async function addPatient(tenant: TestTenant) {
  patientCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Er', 'Care', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `EC-${String(patientCount).padStart(7, '0')}`],
  );
  return rows[0]?.id ?? '';
}
/** A case, on record when `patient` is given. */
const arrive = async (patient?: string, options: Options = {}) =>
  ok<Case>(
    await post(
      '/emergency/cases',
      {
        complaint: 'Chest pain',
        arrivalMode: 'walk_in',
        ...(patient ? { patientId: patient } : {}),
      },
      options,
    ),
    201,
  );
const startOf = (row: Case, options: Options = {}) =>
  post(`/emergency/cases/${row.id}/encounter`, { version: row.version }, options);
const dispose = (row: Case, body: object, options: Options = {}) =>
  post(`/emergency/cases/${row.id}/disposition`, { version: row.version, ...body }, options);
const eventsOf = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at, id',
      [hospital.id, entityId],
    )
  ).rows;

const tenants = () => [hospital, clinic].map((tenant) => tenant.id);
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'er_notes',
      'er_case_links',
      'er_encounters',
      'er_counters',
      'admissions',
      'encounters',
      'outbox',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
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
  hospital = await createTenant(pool, 'ER Care Hospital', {
    features: { emergency: true, patients: true, clinical: true, admissions: true, doctors: true },
  });
  clinic = await createTenant(pool, 'ER Care Clinic', {
    features: { emergency: true, patients: true, clinical: true },
  });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'EC Admin', { withPassword: false });
  doctor = await createUser(pool, 'EC Doctor', { withPassword: false });
  nurse = await createUser(pool, 'EC Nurse', { withPassword: false });
  receptionist = await createUser(pool, 'EC Desk', { withPassword: false });
  clinicAdmin = await createUser(pool, 'EC Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const department = (
    await pool.query<{ id: string }>(
      "insert into departments (tenant_id, name) values ($1, 'Emergency') returning id",
      [hospital.id],
    )
  ).rows[0]?.id;
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'Emergency', 15)`,
    [hospital.id, doctor.id, department],
  );
});

afterAll(async () => {
  try {
    await wipe();
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from doctors where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from departments where tenant_id = any($1)', [tenants()]);
    await deleteUsers(pool, [admin, doctor, nurse, receptionist, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('treatment and notes', () => {
  it('starts treatment once and moves the case on', async () => {
    const row = await arrive();
    const started = await ok<Case>(
      await post(`/emergency/cases/${row.id}/start`, { version: row.version }, { user: nurse }),
    );
    expect(started.status).toBe('in_treatment');
    expect(
      errorOf(
        await post(
          `/emergency/cases/${row.id}/start`,
          { version: started.version },
          { user: nurse },
        ),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(await post(`/emergency/cases/${row.id}/start`, { version: row.version })),
    ).toEqual([409, 'version_conflict']);
    expect((await eventsOf(row.id)).map((event) => event.event)).toContain('er.started');
  });

  it('adds notes that are never changed, in pages, even for an unidentified patient', async () => {
    const row = await arrive();
    for (const body of ['BP 90/60', 'Pain eased after oxygen', 'Awaiting scan']) {
      const note = await ok<Note>(
        await post(
          `/emergency/cases/${row.id}/notes`,
          { kind: 'observation', body },
          { user: nurse },
        ),
        201,
      );
      expect(note.authorName).toBe('EC Nurse');
    }
    const first = await ok<NotePage>(await get(`/emergency/cases/${row.id}/notes?limit=2`));
    expect(first.items.map((note) => note.body)).toEqual(['BP 90/60', 'Pain eased after oxygen']);
    expect(first.nextCursor).not.toBeNull();
    const rest = await ok<NotePage>(
      await get(`/emergency/cases/${row.id}/notes?limit=2&cursor=${first.nextCursor}`),
    );
    expect(rest.items.map((note) => note.body)).toEqual(['Awaiting scan']);
    expect(rest.nextCursor).toBeNull();
    const audit = await pool.query(
      "select 1 from audit_log where tenant_id = $1 and entity = 'er_note' and action = 'read'",
      [hospital.id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(3);
  });

  it('repeats a note with the same key without adding another', async () => {
    const row = await arrive();
    const key = fresh();
    const url = `/emergency/cases/${row.id}/notes`;
    const body = { kind: 'assessment', body: 'Likely angina' };
    const one = await ok<Note>(await post(url, body, {}, key), 201);
    const two = await ok<Note>(await post(url, body, {}, key), 201);
    expect(two.id).toBe(one.id);
    expect((await ok<NotePage>(await get(url))).items).toHaveLength(1);
  });

  it('refuses a bad note, and notes without the care permission', async () => {
    const row = await arrive();
    const url = `/emergency/cases/${row.id}/notes`;
    expect((await post(url, { kind: 'observation', body: '' })).statusCode).toBe(400);
    expect((await post(url, { kind: 'other', body: 'x' })).statusCode).toBe(400);
    expect(
      (await post(url, { kind: 'observation', body: 'x' }, { user: receptionist })).statusCode,
    ).toBe(403);
    expect((await get(url, { user: receptionist })).statusCode).toBe(403);
  });
});

describe('the emergency encounter', () => {
  it('needs the patient on record, then opens once and is the same afterwards', async () => {
    const unknown = await arrive();
    expect(errorOf(await startOf(unknown))).toEqual([409, 'identify_first']);
    const row = await arrive(await addPatient(hospital));
    expect((await startOf(row, { user: nurse })).statusCode).toBe(403);
    const opened = await ok<Case>(await startOf(row, { user: doctor }));
    expect(opened.encounterId).toBeDefined();
    expect(opened.status).toBe('in_treatment');
    const again = await ok<Case>(await startOf(opened, { user: doctor }));
    expect(again.encounterId).toBe(opened.encounterId);
    const encounter = await pool.query<{ type: string; attending_doctor_id: string | null }>(
      'select type, attending_doctor_id from encounters where id = $1',
      [opened.encounterId],
    );
    expect(encounter.rows[0]?.type).toBe('er');
    expect(encounter.rows[0]?.attending_doctor_id).not.toBeNull();
    const events = await eventsOf(opened.encounterId as string);
    expect(events[0]?.payload).toMatchObject({ type: 'er', patientId: row.patientId });
  });

  it('cannot be closed or cancelled from the clinical routes, nor unlinked', async () => {
    const row = await arrive();
    const patient = await addPatient(hospital);
    const linked = await ok<Case>(
      await post(`/emergency/cases/${row.id}/identify`, { patientId: patient, version: 1 }),
    );
    const opened = await ok<Case>(await startOf(linked));
    const close = await post(`/encounters/${opened.encounterId}/close`, {
      version: 1,
    });
    expect(errorOf(close)).toEqual([409, 'managed_by_emergency']);
    expect(
      errorOf(
        await post(`/emergency/cases/${row.id}/unidentify`, {
          version: opened.version,
          reason: 'wrong person',
        }),
      ),
    ).toEqual([409, 'has_encounter']);
  });
});

describe('disposition', () => {
  it('discharges, closes the encounter and keeps the case closed', async () => {
    const row = await arrive(await addPatient(hospital));
    const opened = await ok<Case>(await startOf(row));
    const done = await ok<Case>(await dispose(opened, { type: 'discharge', note: 'Home' }));
    expect(done).toMatchObject({ status: 'disposed', disposition: 'discharge' });
    const encounter = await pool.query<{ status: string }>(
      'select status from encounters where id = $1',
      [opened.encounterId],
    );
    expect(encounter.rows[0]?.status).toBe('closed');
    expect(errorOf(await dispose(done, { type: 'discharge' }))).toEqual([
      409,
      'invalid_transition',
    ]);
    expect(
      errorOf(
        await post(`/emergency/cases/${row.id}/notes`, { kind: 'observation', body: 'late' }),
      ),
    ).toEqual([409, 'invalid_transition']);
    const events = await eventsOf(row.id);
    expect(events.at(-1)).toMatchObject({
      event: 'er.disposed',
      payload: { disposition: 'discharge' },
    });
    expect(JSON.stringify(events)).not.toContain('Home');
    const audit = await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'er_case' and entity_id = $2",
      [hospital.id, row.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toContain('update');
  });

  it('refers with a destination and records an expired patient with the time', async () => {
    const referred = await arrive();
    expect(errorOf(await dispose(referred, { type: 'refer' }))).toEqual([
      422,
      'destination_required',
    ]);
    const gone = await ok<Case>(
      await dispose(referred, { type: 'refer', destination: 'City Heart Institute' }),
    );
    expect(gone).toMatchObject({ disposition: 'refer', destination: 'City Heart Institute' });

    const dead = await arrive();
    expect(errorOf(await dispose(dead, { type: 'expired' }))).toEqual([422, 'death_time_required']);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(errorOf(await dispose(dead, { type: 'expired', deathAt: future }))).toEqual([
      422,
      'death_in_future',
    ]);
    const at = new Date(Date.now() - 600_000).toISOString();
    const closed = await ok<Case>(await dispose(dead, { type: 'expired', deathAt: at }));
    expect(closed.disposition).toBe('expired');
    expect(closed.deathAt).toBe(at);
  });

  it('admits into an inpatient encounter and keeps the emergency history', async () => {
    const row = await arrive(await addPatient(hospital));
    const opened = await ok<Case>(await startOf(row, { user: doctor }));
    await ok<Note>(
      await post(`/emergency/cases/${row.id}/notes`, { kind: 'assessment', body: 'ACS?' }),
      201,
    );
    const done = await ok<Case>(
      await dispose(opened, { type: 'admit', note: 'Cardiac monitoring' }, { user: doctor }),
    );
    expect(done).toMatchObject({ status: 'disposed', disposition: 'admit' });
    expect(done.admissionId).toBeDefined();
    const admission = await pool.query<{
      patient_id: string;
      encounter_id: string;
      admission_type: string;
      status: string;
    }>('select patient_id, encounter_id, admission_type, status from admissions where id = $1', [
      done.admissionId,
    ]);
    expect(admission.rows[0]).toMatchObject({
      patient_id: row.patientId,
      admission_type: 'emergency',
      status: 'admitted',
    });
    const encounters = await pool.query<{ type: string; status: string }>(
      'select type, status from encounters where patient_id = $1 order by type',
      [row.patientId],
    );
    expect(encounters.rows).toEqual([
      { type: 'er', status: 'closed' },
      { type: 'ipd', status: 'open' },
    ]);
    // The notes written in the department are still there.
    expect((await ok<NotePage>(await get(`/emergency/cases/${row.id}/notes`))).items).toHaveLength(
      1,
    );
    const events = (await eventsOf(row.id)).at(-1);
    expect(events?.payload).toMatchObject({ disposition: 'admit', admissionId: done.admissionId });
  });

  it('refuses to admit an unidentified patient, one already admitted, and without the right', async () => {
    const unknown = await arrive();
    expect(errorOf(await dispose(unknown, { type: 'admit' }, { user: doctor }))).toEqual([
      409,
      'identify_first',
    ]);
    const patient = await addPatient(hospital);
    const first = await arrive(patient);
    await ok<Case>(await dispose(first, { type: 'admit' }, { user: doctor }));
    const second = await arrive(patient);
    expect(errorOf(await dispose(second, { type: 'admit' }, { user: doctor }))).toEqual([
      409,
      'already_admitted',
    ]);
    // Nothing was half-done: the second case is still open.
    expect((await ok<Case>(await get(`/emergency/cases/${second.id}`))).status).toBe('waiting');
    // A nurse may care but not decide.
    expect((await dispose(second, { type: 'discharge' }, { user: nurse })).statusCode).toBe(403);
  });
});

describe('the hospital boundary', () => {
  it('shows a case to its own hospital only', async () => {
    const mine = await arrive();
    expect(
      (await get(`/emergency/cases/${mine.id}`, { tenant: clinic, user: clinicAdmin })).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          `/emergency/cases/${mine.id}/notes`,
          { kind: 'observation', body: 'x' },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await dispose(mine, { type: 'discharge' }, { tenant: clinic, user: clinicAdmin }))
        .statusCode,
    ).toBe(404);
    expect(
      (await get(`/emergency/cases/${mine.id}/notes`, { tenant: clinic, user: clinicAdmin }))
        .statusCode,
    ).toBe(404);
  });

  it('keeps admitting off when the admissions module is off', async () => {
    const patient = await addPatient(clinic);
    const row = await arrive(patient, { tenant: clinic, user: clinicAdmin });
    expect(
      errorOf(await dispose(row, { type: 'admit' }, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([403, 'permission_denied']);
  });
});
