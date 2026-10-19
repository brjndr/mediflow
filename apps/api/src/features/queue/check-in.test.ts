import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * Checking in a booked patient (#376) through the real app and database: one token per
 * appointment, the place in the call order, the appointment's status and day, the hospital
 * boundary, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** The queue module switched off. */
let closed: TestTenant;
let desk: TestUser;
let doctor: TestUser;
let clinicDesk: TestUser;
/** A receptionist at the hospital who is also a doctor of General Medicine: an `own` scope reaches. */
let deskDoctor: TestUser;
const departments = { general: '', clinic: '', closed: '' };
const doctors = { a: '', deskDoctor: '', clinic: '', closed: '' };
const patients = { one: '', two: '', three: '', clinic: '', closed: '' };

interface Token {
  id: string;
  number: number;
  departmentId: string;
  doctorId?: string;
  patientId: string;
  appointmentId?: string;
  status: string;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Reply = { statusCode: number; json: <T = { error: { code: string } }>() => T };

const checkIn = (appointmentId: string, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/queue/check-ins',
    headers: {
      ...as((options.tenant ?? hospital).id, (options.user ?? desk).id),
      'idempotency-key': options.key ?? randomUUID(),
    },
    payload: { appointmentId },
  });
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

/** When an appointment starts, relative to the hospital's day: never on another day. */
type When = 'earlier_today' | 'later_today' | 'tomorrow';
const STARTS: Record<When, string> = {
  // Within today at the hospital, a minute ago at most, and an hour ahead at most.
  earlier_today: `greatest(date_trunc('day', now() at time zone t.timezone) at time zone t.timezone,
                           now() - interval '1 minute')`,
  later_today: `least(date_trunc('day', now() at time zone t.timezone) at time zone t.timezone
                        + interval '1 day' - interval '2 minutes',
                      now() + interval '1 hour')`,
  tomorrow: `date_trunc('day', now() at time zone t.timezone) at time zone t.timezone + interval '1 day 10 hours'`,
};

async function addAppointment(
  tenant: TestTenant,
  patientId: string,
  doctorId: string,
  when: When,
  status: 'scheduled' | 'cancelled' = 'scheduled',
) {
  const cancelled = status === 'cancelled';
  const { rows } = await pool.query<{ id: string }>(
    `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, status, cancel_reason, created_by)
     select t.id, $2, $3, s.at, s.at + interval '1 minute', $4, $5, 'test'
     from tenants t, lateral (select ${STARTS[when]} as at) s
     where t.id = $1
     returning id`,
    [tenant.id, patientId, doctorId, status, cancelled ? 'duplicate' : null],
  );
  return rows[0]?.id ?? '';
}

async function addDepartment(tenant: TestTenant, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, name],
  );
  return rows[0]?.id ?? '';
}

async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General practice', 15) returning id`,
    [tenant.id, user.id, departmentId],
  );
  return rows[0]?.id ?? '';
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-01-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CI-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

/** Takes a permission away from the receptionist role at the hospital, for the length of `run`. */
async function without<T>(permission: string, run: () => Promise<T>) {
  await pool.query(
    `delete from role_permissions where tenant_id = $1 and role_id = 'receptionist' and permission = $2`,
    [hospital.id, permission],
  );
  try {
    return await run();
  } finally {
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope)
       values ($1, 'receptionist', $2, 'all') on conflict do nothing`,
      [hospital.id, permission],
    );
  }
}

/** Narrows a permission of the receptionist role at the hospital, for the length of `run`. */
async function withScope<T>(
  permission: string,
  scope: 'own' | 'department',
  run: () => Promise<T>,
) {
  const set = (to: string) =>
    pool.query(
      `update role_permissions set scope = $3
       where tenant_id = $1 and role_id = 'receptionist' and permission = $2`,
      [hospital.id, permission, to],
    );
  await set(scope);
  try {
    return await run();
  } finally {
    await set('all');
  }
}

const tenants = () => [hospital.id, clinic.id, closed.id];

const clear = async () => {
  await pool.query('delete from queue_tokens where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from queue_counters where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from appointments where tenant_id = any($1)', [tenants()]);
};

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = {
    queue: true,
    appointments: true,
    patients: true,
    doctors: true,
    departments: true,
  };
  hospital = await createTenant(pool, 'Check-in Hospital', { features });
  clinic = await createTenant(pool, 'Check-in Clinic', { features, timezone: 'Asia/Dubai' });
  closed = await createTenant(pool, 'Check-in Closed', {
    features: { ...features, queue: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  desk = await user('Check-in Desk');
  doctor = await user('Check-in Doctor');
  clinicDesk = await user('Check-in Clinic Desk');
  deskDoctor = await user('Check-in Desk Doctor');
  await addMembership(pool, deskDoctor, hospital, 'receptionist');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, desk, closed, 'receptionist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, doctor, closed, 'doctor');
  await addMembership(pool, clinicDesk, clinic, 'receptionist');
  departments.general = await addDepartment(hospital, 'General Medicine');
  departments.clinic = await addDepartment(clinic, 'Family Medicine');
  departments.closed = await addDepartment(closed, 'General Medicine');
  doctors.a = await addDoctor(hospital, doctor, departments.general);
  doctors.deskDoctor = await addDoctor(hospital, deskDoctor, departments.general);
  doctors.clinic = await addDoctor(clinic, doctor, departments.clinic);
  doctors.closed = await addDoctor(closed, doctor, departments.closed);
  patients.one = await addPatient(hospital, 'Priya');
  patients.two = await addPatient(hospital, 'Ravi');
  patients.three = await addPatient(hospital, 'Meena');
  patients.clinic = await addPatient(clinic, 'Omar');
  patients.closed = await addPatient(closed, 'Asha');
});

afterEach(clear);

afterAll(async () => {
  await clear();
  await pool.query('delete from outbox where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from doctors where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from departments where tenant_id = any($1)', [tenants()]);
  await deleteUsers(pool, [desk, doctor, clinicDesk, deskDoctor]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('checking in a booked patient', () => {
  it('issues a token in the doctor’s department, for the doctor, linked to the appointment', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const response = await checkIn(appointment);
    expect(response.statusCode).toBe(201);
    const token = response.json<Token>();
    expect(token).toMatchObject({
      number: 1,
      departmentId: departments.general,
      doctorId: doctors.a,
      patientId: patients.one,
      appointmentId: appointment,
      status: 'waiting',
    });
    const audit = await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and entity = 'queue_token' and entity_id = $2`,
      [hospital.id, token.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['create']);
    const event = await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2',
      [hospital.id, token.id],
    );
    expect(event.rows).toEqual([
      {
        event: 'queue.token_issued',
        payload: expect.objectContaining({ appointmentId: appointment, doctorId: doctors.a }),
      },
    ]);
  });

  it('gives the first token when the appointment is checked in again, from any desk', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const key = randomUUID();
    const first = await checkIn(appointment, { key });
    const repeat = await checkIn(appointment, { key });
    const again = await checkIn(appointment);
    expect(first.statusCode).toBe(201);
    expect(repeat.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    const id = first.json<Token>().id;
    expect(repeat.json<Token>().id).toBe(id);
    expect(again.json<Token>().id).toBe(id);
    const { rows } = await pool.query('select id from queue_tokens where appointment_id = $1', [
      appointment,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('issues one token when two desks check the same appointment in at once', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const answers = await Promise.all([checkIn(appointment), checkIn(appointment)]);
    const statuses = answers.map((answer) => answer.statusCode).sort();
    expect([
      [200, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    const { rows } = await pool.query('select id from queue_tokens where appointment_id = $1', [
      appointment,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('places a patient who came before the booked time at that time, and a late one at arrival', async () => {
    const early = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const late = await addAppointment(hospital, patients.three, doctors.a, 'earlier_today');
    expect((await checkIn(early)).statusCode).toBe(201);
    const walkIn = await app.inject({
      method: 'POST',
      url: '/queue/tokens',
      headers: { ...as(hospital.id, desk.id), 'idempotency-key': randomUUID() },
      payload: { patientId: patients.two, departmentId: departments.general },
    });
    expect(walkIn.statusCode).toBe(201);
    expect((await checkIn(late)).statusCode).toBe(201);
    const page = await app.inject({
      url: `/queue/tokens?status=waiting&doctorId=${doctors.a}`,
      headers: as(hospital.id, desk.id),
    });
    // The walk-in came before the early patient's booked time; the late one at arrival, after it.
    expect(page.json<{ items: Token[] }>().items.map((token) => token.patientId)).toEqual([
      patients.two,
      patients.three,
      patients.one,
    ]);
  });

  it('refuses an appointment that is not scheduled, or not today', async () => {
    const cancelled = await addAppointment(
      hospital,
      patients.one,
      doctors.a,
      'later_today',
      'cancelled',
    );
    const tomorrow = await addAppointment(hospital, patients.two, doctors.a, 'tomorrow');
    expect(errorOf(await checkIn(cancelled))).toEqual([409, 'invalid_transition']);
    expect(errorOf(await checkIn(tomorrow))).toEqual([422, 'not_today']);
  });

  it('refuses a patient already waiting in that department as a walk-in', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    await app.inject({
      method: 'POST',
      url: '/queue/tokens',
      headers: { ...as(hospital.id, desk.id), 'idempotency-key': randomUUID() },
      payload: { patientId: patients.one, departmentId: departments.general },
    });
    expect(errorOf(await checkIn(appointment))).toEqual([409, 'already_queued']);
  });

  it('never changes a token’s appointment or its place in the line', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const token = (await checkIn(appointment)).json<Token>();
    await expect(
      pool.query('update queue_tokens set appointment_id = null where id = $1', [token.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('update queue_tokens set line_at = now() where id = $1', [token.id]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('who may check a patient in', () => {
  it('refuses a role without queue:create, and one without appointment:read', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    expect(errorOf(await checkIn(appointment, { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    await without('appointment:read', async () => {
      expect(errorOf(await checkIn(appointment))).toEqual([403, 'permission_denied']);
    });
  });

  it('refuses a role that may not read the patient as if the patient did not exist', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    await without('patient:read', async () => {
      expect(errorOf(await checkIn(appointment))).toEqual([422, 'unknown_patient']);
    });
  });

  it('is closed when the hospital has the queue switched off', async () => {
    const appointment = await addAppointment(
      closed,
      patients.closed,
      doctors.closed,
      'later_today',
    );
    expect(errorOf(await checkIn(appointment, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the appointments module', () => {
  it('is closed when the hospital has appointments switched off', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const flag = (enabled: boolean) =>
      pool.query(
        `update tenant_features set enabled = $2 where tenant_id = $1 and feature = 'appointments'`,
        [hospital.id, enabled],
      );
    await flag(false);
    try {
      expect(errorOf(await checkIn(appointment))).toEqual([403, 'feature_disabled']);
    } finally {
      await flag(true);
    }
  });
});

describe('the caller’s scope', () => {
  it('answers an appointment outside the scope of appointment:read as one that does not exist', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    // The desk has no doctor profile, so a department scope reaches nothing.
    await withScope('appointment:read', 'department', async () => {
      expect(errorOf(await checkIn(appointment))).toEqual([422, 'unknown_appointment']);
    });
  });

  it('issues only in a department the scope of queue:create reaches', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    await withScope('queue:create', 'department', async () => {
      expect(errorOf(await checkIn(appointment))).toEqual([422, 'unknown_department']);
    });
  });

  it('never hands a token out of reach to a second desk, which is refused instead', async () => {
    const appointment = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    const first = await checkIn(appointment);
    expect(first.statusCode).toBe(201);
    const { id } = first.json<Token>();
    // Their own queue does not hold doctor A's token: a second one is refused, never given.
    await withScope('queue:create', 'own', async () => {
      // While it is open, by the one open token per patient and department.
      expect(errorOf(await checkIn(appointment, { user: deskDoctor }))).toEqual([
        409,
        'already_queued',
      ]);
      // Once served, by the one token per appointment.
      await pool.query(
        `update queue_tokens set status = 'called', called_at = now() where id = $1`,
        [id],
      );
      await pool.query(`update queue_tokens set status = 'served' where id = $1`, [id]);
      expect(errorOf(await checkIn(appointment, { user: deskDoctor }))).toEqual([
        409,
        'already_checked_in',
      ]);
    });
  });
});

describe('the hospital boundary', () => {
  it('answers another hospital’s appointment as one that does not exist', async () => {
    const theirs = await addAppointment(clinic, patients.clinic, doctors.clinic, 'later_today');
    expect(errorOf(await checkIn(theirs))).toEqual([422, 'unknown_appointment']);
    expect(errorOf(await checkIn(randomUUID()))).toEqual([422, 'unknown_appointment']);
    expect(errorOf(await checkIn('not-an-id'))).toEqual([422, 'unknown_appointment']);
    const ours = await addAppointment(hospital, patients.one, doctors.a, 'later_today');
    expect(errorOf(await checkIn(ours, { tenant: clinic, user: clinicDesk }))).toEqual([
      422,
      'unknown_appointment',
    ]);
  });

  it('refuses a token that names another hospital’s appointment in the database', async () => {
    const theirs = await addAppointment(clinic, patients.clinic, doctors.clinic, 'later_today');
    await expect(
      pool.query(
        `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by, appointment_id)
         values ($1, current_date, $2, 99, $3, $4, $5)`,
        [hospital.id, departments.general, patients.one, desk.id, theirs],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
