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
 * Bed reservations (#582): holding a bed for a patient until a time, the board showing it, the
 * bed refused to anyone else and given to the patient it is held for, expiry, cancelling, the
 * hospital boundary and permissions.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let doctor: TestUser;
let nurse: TestUser;
let pharmacist: TestUser;
let clinicNurse: TestUser;
const beds: string[] = [];
const patients: string[] = [];
let clinicBed = '';
let clinicPatient = '';

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
interface BoardBed {
  id: string;
  status: string;
  reservation?: { id: string; patientId: string; patientName: string; expiresAt: string };
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
let keys = 0;
const post = (url: string, body: object, { tenant = hospital, user = nurse }: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      ...as(tenant.id, user.id),
      'idempotency-key': `res-key-${String(++keys).padStart(6, '0')}`,
    },
    payload: body,
  });
const get = (url: string, { tenant = hospital, user = nurse }: Options = {}) =>
  app.inject({ url, headers: as(tenant.id, user.id) });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const reserve = (bedId: string, patientId: string, more: object = {}, options: Options = {}) =>
  post(`/beds/${bedId}/reservations`, { patientId, expiresAt: inHours(24), ...more }, options);
const bed = (n: number) => beds[n] ?? '';
const patient = (n: number) => patients[n] ?? '';
const boardOf = async (bedId: string): Promise<BoardBed | undefined> =>
  (await get('/beds/board?limit=100'))
    .json<{ items: BoardBed[] }>()
    .items.find((item) => item.id === bedId);
const clear = async () => {
  await pool.query('delete from bed_reservations where tenant_id = any($1)', [
    [hospital.id, clinic.id],
  ]);
};
/** Time passing: the guard forbids editing a reservation, so the trigger is skipped. */
const lapse = async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `update bed_reservations set created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour' where tenant_id = $1`,
      [hospital.id],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
};
const reset = async () => {
  await clear();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query('delete from bed_assignments where tenant_id = any($1)', [[hospital.id]]);
    await client.query("update beds set status = 'available' where tenant_id = $1", [hospital.id]);
    for (const table of ['clinical_notes', 'admissions', 'encounters', 'outbox']) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Rsv', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `RV-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}
async function structure(tenant: TestTenant, departmentId: string, count: number) {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
  const category = await one(
    'insert into bed_categories (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, 'General'],
  );
  const wardId = await one(
    'insert into wards (tenant_id, code, name, department_id) values ($1, $2, $3, $4) returning id',
    [tenant.id, 'W1', 'Ward One', departmentId],
  );
  const room = await one(
    'insert into rooms (tenant_id, ward_id, name) values ($1, $2, $3) returning id',
    [tenant.id, wardId, 'Room 1'],
  );
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    ids.push(
      await one(
        'insert into beds (tenant_id, ward_id, room_id, number, bed_category_id) values ($1, $2, $3, $4, $5) returning id',
        [tenant.id, wardId, room, `B${n}`, category],
      ),
    );
  }
  return ids;
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = {
    features: {
      admissions: true,
      wards: true,
      clinical: true,
      patients: true,
      doctors: true,
      departments: true,
    },
  };
  hospital = await createTenant(pool, 'Rsv Hospital', on);
  clinic = await createTenant(pool, 'Rsv Clinic', on);
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  doctor = await createUser(pool, 'Rsv Doctor', { withPassword: false });
  nurse = await createUser(pool, 'Rsv Nurse', { withPassword: false });
  pharmacist = await createUser(pool, 'Rsv Pharmacist', { withPassword: false });
  clinicNurse = await createUser(pool, 'Rsv Clinic Nurse', { withPassword: false });
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicNurse, clinic, 'nurse');
  const department = async (tenant: TestTenant) =>
    (
      await pool.query<{ id: string }>(
        'insert into departments (tenant_id, name) values ($1, $2) returning id',
        [tenant.id, 'Medicine'],
      )
    ).rows[0]?.id ?? '';
  const hospitalDepartment = await department(hospital);
  const clinicDepartment = await department(clinic);
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15)`,
    [hospital.id, doctor.id, hospitalDepartment],
  );
  beds.push(...(await structure(hospital, hospitalDepartment, 3)));
  clinicBed = (await structure(clinic, clinicDepartment, 1))[0] ?? '';
  for (const name of ['Asha', 'Bina', 'Chitra']) patients.push(await addPatient(hospital, name));
  clinicPatient = await addPatient(clinic, 'Clinic');
});

afterAll(async () => {
  try {
    await reset();
    for (const table of [
      'beds',
      'rooms',
      'wards',
      'bed_categories',
      'doctors',
      'patients',
      'departments',
    ]) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id],
      ]);
    }
    await deleteUsers(pool, [doctor, nurse, pharmacist, clinicNurse].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('reserving a bed', () => {
  it('holds a bed for a patient, shows it on the board, audits and emits', async () => {
    await reset();
    const response = await reserve(bed(0), patient(0), { note: 'Planned surgery' });
    expect(response.statusCode).toBe(201);
    const view = response.json<BoardBed>();
    expect(view.reservation).toMatchObject({ patientId: patient(0), patientName: 'Asha Rsv' });
    expect((await boardOf(bed(0)))?.reservation?.patientName).toBe('Asha Rsv');
    expect((await boardOf(bed(1)))?.reservation).toBeUndefined();

    const events = await pool.query<{ event: string; payload: Record<string, unknown> }>(
      "select event, payload from outbox where tenant_id = $1 and event = 'bed.reserved'",
      [hospital.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows[0]?.payload)).not.toContain('Planned surgery');
    const audit = await pool.query(
      "select 1 from audit_log where tenant_id = $1 and entity = 'bed_reservation'",
      [hospital.id],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('refuses a second hold on the bed and a second bed for the patient', async () => {
    await reset();
    await reserve(bed(0), patient(0));
    expect(errorOf(await reserve(bed(0), patient(1)))).toEqual([409, 'bed_reserved']);
    expect(errorOf(await reserve(bed(1), patient(0)))).toEqual([409, 'patient_has_reservation']);
  });

  it('refuses a past or too distant time, a blocked bed and an unknown patient or bed', async () => {
    await reset();
    expect(errorOf(await reserve(bed(0), patient(0), { expiresAt: inHours(-1) }))).toEqual([
      422,
      'invalid_expiry',
    ]);
    expect(errorOf(await reserve(bed(0), patient(0), { expiresAt: inHours(24 * 30) }))).toEqual([
      422,
      'invalid_expiry',
    ]);
    expect(errorOf(await reserve(bed(0), clinicPatient))).toEqual([422, 'unknown_patient']);
    expect(errorOf(await reserve(clinicBed, patient(0)))).toEqual([404, 'bed_not_found']);
    await pool.query(
      "update beds set status = 'blocked', blocked_reason = 'maintenance' where id = $1",
      [bed(2)],
    );
    expect(errorOf(await reserve(bed(2), patient(0)))).toEqual([409, 'bed_not_available']);
    await pool.query("update beds set status = 'available', blocked_reason = null where id = $1", [
      bed(2),
    ]);
  });

  it('replays an idempotent request without holding twice', async () => {
    await reset();
    const key = 'res-replay-0001';
    const payload = { patientId: patient(0), expiresAt: inHours(24) };
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/beds/${bed(0)}/reservations`,
        headers: { ...as(hospital.id, nurse.id), 'idempotency-key': key },
        payload,
      });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(201);
    const { rows } = await pool.query('select 1 from bed_reservations where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('a held bed', () => {
  it('cannot be given to someone else, but to the patient it is held for it can, ending the hold', async () => {
    await reset();
    await reserve(bed(0), patient(0));
    const refused = await post(
      '/admissions',
      { patientId: patient(1), admissionType: 'planned', bedId: bed(0) },
      { user: doctor },
    );
    expect(errorOf(refused)).toEqual([409, 'bed_reserved']);

    const admitted = await post(
      '/admissions',
      { patientId: patient(0), admissionType: 'planned', bedId: bed(0) },
      { user: doctor },
    );
    expect(admitted.statusCode).toBe(201);
    const { rows } = await pool.query<{ release_reason: string }>(
      'select release_reason from bed_reservations where tenant_id = $1',
      [hospital.id],
    );
    expect(rows.map((row) => row.release_reason)).toEqual(['fulfilled']);
    expect((await boardOf(bed(0)))?.reservation).toBeUndefined();
  });

  it('cannot be taken by a transfer of someone else, and one patient given another bed lets the hold go', async () => {
    await reset();
    const stay = await post(
      '/admissions',
      { patientId: patient(1), admissionType: 'planned', bedId: bed(1) },
      { user: doctor },
    );
    const detail = stay.json<{ admission: { id: string; version: number } }>();
    await reserve(bed(0), patient(0));
    const moved = await post(
      `/admissions/${detail.admission.id}/transfer`,
      { bedId: bed(0), version: detail.admission.version },
      { user: doctor },
    );
    expect(errorOf(moved)).toEqual([409, 'bed_reserved']);

    // The held-for patient is admitted to another bed: the hold on bed 0 ends.
    const other = await post(
      '/admissions',
      { patientId: patient(0), admissionType: 'planned', bedId: bed(2) },
      { user: doctor },
    );
    expect(other.statusCode).toBe(201);
    expect((await boardOf(bed(0)))?.reservation).toBeUndefined();
  });

  it('is free again once its time passes', async () => {
    await reset();
    await reserve(bed(0), patient(0));
    await lapse();
    expect((await boardOf(bed(0)))?.reservation).toBeUndefined();
    const taken = await post(
      '/admissions',
      { patientId: patient(1), admissionType: 'planned', bedId: bed(0) },
      { user: doctor },
    );
    expect(taken.statusCode).toBe(201);
    // And it can be reserved again by someone else after a lapse.
    await reset();
    await reserve(bed(0), patient(0));
    await lapse();
    expect((await reserve(bed(0), patient(1))).statusCode).toBe(201);
    const { rows } = await pool.query<{ release_reason: string | null }>(
      'select release_reason from bed_reservations where tenant_id = $1 order by created_at',
      [hospital.id],
    );
    expect(rows.map((row) => row.release_reason)).toEqual(['expired', null]);
  });

  it('two requests for one bed give it to one patient', async () => {
    await reset();
    const [a, b] = await Promise.all([reserve(bed(0), patient(0)), reserve(bed(0), patient(1))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });
});

describe('cancelling a reservation', () => {
  it('lets the bed go and frees it for others', async () => {
    await reset();
    const view = (await reserve(bed(0), patient(0))).json<BoardBed>();
    const id = view.reservation?.id ?? '';
    const response = await post(`/bed-reservations/${id}/cancel`, {});
    expect(response.statusCode).toBe(200);
    expect(response.json<BoardBed>().reservation).toBeUndefined();
    expect(errorOf(await post(`/bed-reservations/${id}/cancel`, {}))).toEqual([
      409,
      'reservation_ended',
    ]);
    expect(
      (
        await post(
          '/admissions',
          { patientId: patient(1), admissionType: 'planned', bedId: bed(0) },
          { user: doctor },
        )
      ).statusCode,
    ).toBe(201);
  });

  it('is 404 for a reservation of another hospital', async () => {
    await reset();
    const id = (await reserve(bed(0), patient(0))).json<BoardBed>().reservation?.id ?? '';
    expect(
      errorOf(
        await post(`/bed-reservations/${id}/cancel`, {}, { tenant: clinic, user: clinicNurse }),
      ),
    ).toEqual([404, 'reservation_not_found']);
  });
});

describe('access', () => {
  it('needs bed:reserve', async () => {
    await reset();
    expect((await reserve(bed(0), patient(0), {}, { user: doctor })).statusCode).toBe(403);
    expect((await reserve(bed(0), patient(0), {}, { user: pharmacist })).statusCode).toBe(403);
  });
});
