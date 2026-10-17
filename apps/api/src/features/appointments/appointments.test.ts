import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * The appointments API through the real app and database: booking against the doctor's hours,
 * the exclusion constraints under concurrent requests, the changes of status, the hospital
 * boundary, scope, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
/** Asia/Kolkata (UTC+05:30). */
let hospital: TestTenant;
/** Asia/Dubai (UTC+04:00). */
let clinic: TestTenant;
/** The appointments module switched off. */
let closed: TestTenant;
let admin: TestUser;
let desk: TestUser;
let docA: TestUser;
let docB: TestUser;
let nurse: TestUser;
let storeKeeper: TestUser;
let clinicDoc: TestUser;
/** Doctor profile ids: A in General, B in Surgery, at the hospital; C at the clinic. */
const doctors = { a: '', b: '', c: '', inactive: '', closed: '' };
/** Patient ids. */
const patients = { one: '', two: '', three: '', clinic: '', closed: '' };
/** Six more of the hospital's, one for each request of the concurrency test. */
const crowd: string[] = [];
/** Tomorrow at each hospital, as YYYY-MM-DD. */
let tomorrow = '';
let clinicTomorrow = '';

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string | null;
}
interface Appointment {
  id: string;
  tenantId: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  doctorId: string;
  doctorName: string;
  departmentName?: string;
  startsAt: string;
  endsAt: string;
  status: string;
  version: number;
  reason?: string;
  cancellation?: { reason: string; note?: string };
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface FreeSlots {
  doctorId: string;
  day: string;
  slotMinutes: number;
  slots: { startsAt: string; endsAt: string }[];
}
type Reply = { statusCode: number; json: <T = { error: { code: string } }>() => T };

const headers = ({ tenant = hospital, user = desk, key = randomUUID() }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key === null ? {} : { 'idempotency-key': key }),
});
const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? desk).id) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({ method: 'POST', url, headers: headers(options), payload: body });
const book = (body: object, options: Options = {}) => post('/appointments', body, options);
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

/** 09:00 and later on a day at a hospital of that UTC offset, as an ISO instant. */
const at = (day: string, time: string, offset = '+05:30') =>
  new Date(`${day}T${time}:00${offset}`).toISOString();

async function booked(body: object, options: Options = {}): Promise<Appointment> {
  const response = await book(body, options);
  if (response.statusCode !== 201) {
    throw new Error(`booking failed in test setup: ${response.statusCode} ${response.body}`);
  }
  return response.json<Appointment>();
}

/** An appointment written straight to the table, for times the API would not book (the past). */
async function inserted(
  tenant: TestTenant,
  patientId: string,
  doctorId: string,
  startsAt: string,
  minutes = 15,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, created_by)
     values ($1, $2, $3, $4, $4::timestamptz + make_interval(mins => $5), 'test') returning id`,
    [tenant.id, patientId, doctorId, startsAt, minutes],
  );
  return rows[0]?.id ?? '';
}

const clearAppointments = () =>
  pool.query('delete from appointments where tenant_id = any($1)', [
    [hospital.id, clinic.id, closed.id],
  ]);

async function addDepartment(tenant: TestTenant, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, name],
  );
  return rows[0]?.id ?? '';
}

/** A profile working 09:00 to 13:00 every day, in 15-minute appointments. */
async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string, active = true) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes, active)
     values ($1, $2, $3, 'General practice', 15, $4) returning id`,
    [tenant.id, user.id, departmentId, active],
  );
  const id = rows[0]?.id ?? '';
  await pool.query(
    `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
     select $1, $2, day, 540, 780 from generate_series(1, 7) as day`,
    [tenant.id, id],
  );
  return id;
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string, last: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, $4, '1980-01-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `AP-${String(mrn).padStart(7, '0')}`, first, last],
  );
  return rows[0]?.id ?? '';
}

const tomorrowIn = async (timezone: string) =>
  (
    await pool.query<{ day: string }>('select ((now() at time zone $1)::date + 1)::text as day', [
      timezone,
    ])
  ).rows[0]?.day ?? '';

const audited = async (tenant: TestTenant, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and entity = 'appointment' and entity_id = $2 order by at`,
      [tenant.id, entityId],
    )
  ).rows.map((row) => row.action);

const events = async (tenant: TestTenant, entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at',
      [tenant.id, entityId],
    )
  ).rows;

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { appointments: true, patients: true, doctors: true, departments: true };
  hospital = await createTenant(pool, 'Appointments Hospital', { features });
  clinic = await createTenant(pool, 'Appointments Clinic', { features, timezone: 'Asia/Dubai' });
  closed = await createTenant(pool, 'Appointments Closed', {
    features: { ...features, appointments: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Appt Admin');
  desk = await user('Appt Desk');
  docA = await user('Anil Doctor');
  docB = await user('Bina Doctor');
  nurse = await user('Appt Nurse');
  storeKeeper = await user('Appt Store');
  clinicDoc = await user('Clinic Doctor');
  for (const tenant of [hospital, clinic, closed]) {
    await addMembership(pool, admin, tenant, 'admin');
    await addMembership(pool, desk, tenant, 'receptionist');
  }
  await addMembership(pool, docA, hospital, 'doctor');
  await addMembership(pool, docB, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
  await addMembership(pool, clinicDoc, clinic, 'doctor');
  await addMembership(pool, docA, closed, 'doctor');
  const general = await addDepartment(hospital, 'General Medicine');
  const surgery = await addDepartment(hospital, 'Surgery');
  doctors.a = await addDoctor(hospital, docA, general);
  doctors.b = await addDoctor(hospital, docB, surgery);
  doctors.inactive = await addDoctor(hospital, nurse, general, false);
  doctors.c = await addDoctor(clinic, clinicDoc, await addDepartment(clinic, 'Family Medicine'));
  doctors.closed = await addDoctor(closed, docA, await addDepartment(closed, 'General'));
  patients.one = await addPatient(hospital, 'Priya', 'Sharma');
  patients.two = await addPatient(hospital, 'Ravi', 'Kumar');
  patients.three = await addPatient(hospital, 'Meena', 'Das');
  for (let n = 1; n <= 6; n++) crowd.push(await addPatient(hospital, 'Crowd', `Member ${n}`));
  patients.clinic = await addPatient(clinic, 'Omar', 'Ali');
  patients.closed = await addPatient(closed, 'Shut', 'Away');
  tomorrow = await tomorrowIn('Asia/Kolkata');
  clinicTomorrow = await tomorrowIn('Asia/Dubai');
});

afterEach(clearAppointments);

afterAll(async () => {
  await clearAppointments();
  const tenants = [hospital.id, clinic.id, closed.id];
  await pool.query('delete from outbox where tenant_id = any($1)', [tenants]);
  await pool.query('delete from patients where tenant_id = any($1)', [tenants]);
  await pool.query('delete from doctors where tenant_id = any($1)', [tenants]);
  await pool.query('delete from departments where tenant_id = any($1)', [tenants]);
  await deleteUsers(pool, [admin, desk, docA, docB, nurse, storeKeeper, clinicDoc]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('free slots', () => {
  it('cuts the hours into the consultation length, in the hospital’s timezone', async () => {
    const response = await get(`/appointments/free-slots?doctorId=${doctors.a}&day=${tomorrow}`);
    expect(response.statusCode).toBe(200);
    const free = response.json<FreeSlots>();
    expect(free.slotMinutes).toBe(15);
    expect(free.slots).toHaveLength(16);
    expect(free.slots[0]).toEqual({
      startsAt: at(tomorrow, '09:00'),
      endsAt: at(tomorrow, '09:15'),
    });
    expect(free.slots.at(-1)?.startsAt).toBe(at(tomorrow, '12:45'));

    const atClinic = await get(
      `/appointments/free-slots?doctorId=${doctors.c}&day=${clinicTomorrow}`,
      { tenant: clinic },
    );
    expect(atClinic.json<FreeSlots>().slots[0]?.startsAt).toBe(
      at(clinicTomorrow, '09:00', '+04:00'),
    );
  });

  it('leaves out held times, and gives them back when cancelled or a no-show', async () => {
    const first = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const slots = async () =>
      (
        await get(`/appointments/free-slots?doctorId=${doctors.a}&day=${tomorrow}`)
      ).json<FreeSlots>().slots;
    expect((await slots()).map((slot) => slot.startsAt)).not.toContain(at(tomorrow, '09:00'));
    await post(`/appointments/${first.id}/cancel`, { version: 1, reason: 'patient_request' });
    expect((await slots()).map((slot) => slot.startsAt)).toContain(at(tomorrow, '09:00'));
  });

  it('is empty before today and past 90 days, and 404 for an unknown or inactive doctor', async () => {
    const empty = async (day: string) =>
      (await get(`/appointments/free-slots?doctorId=${doctors.a}&day=${day}`)).json<FreeSlots>()
        .slots;
    expect(await empty('2020-01-01')).toEqual([]);
    expect(await empty('2099-01-01')).toEqual([]);
    for (const id of [doctors.inactive, doctors.c, randomUUID(), 'nope']) {
      const response = await get(`/appointments/free-slots?doctorId=${id}&day=${tomorrow}`);
      expect(errorOf(response)).toEqual([404, 'not_found']);
    }
    const badDay = await get(`/appointments/free-slots?doctorId=${doctors.a}&day=2026-02-31`);
    expect(errorOf(badDay)).toEqual([400, 'validation_failed']);
  });

  it('needs appointment:create or appointment:update', async () => {
    const url = `/appointments/free-slots?doctorId=${doctors.a}&day=${tomorrow}`;
    expect(errorOf(await get(url, { user: nurse }))).toEqual([403, 'permission_denied']);
    expect((await get(url, { user: admin })).statusCode).toBe(200);
    // Either is enough: a role that moves bookings and does not make them.
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope)
       values ($1, 'nurse', 'appointment:update', 'all')`,
      [hospital.id],
    );
    try {
      expect((await get(url, { user: nurse })).statusCode).toBe(200);
    } finally {
      await pool.query(
        `delete from role_permissions
         where tenant_id = $1 and role_id = 'nurse' and permission = 'appointment:update'`,
        [hospital.id],
      );
    }
  });
});

describe('booking', () => {
  it('books a free slot, names the patient, audits and announces it', async () => {
    const response = await book({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '10:00'),
      reason: '  Follow   up ',
    });
    expect(response.statusCode).toBe(201);
    const appointment = response.json<Appointment>();
    expect(appointment).toMatchObject({
      tenantId: hospital.id,
      patientId: patients.one,
      patientName: 'Priya Sharma',
      doctorId: doctors.a,
      doctorName: 'Anil Doctor',
      departmentName: 'General Medicine',
      startsAt: at(tomorrow, '10:00'),
      endsAt: at(tomorrow, '10:15'),
      status: 'scheduled',
      version: 1,
      reason: 'Follow up',
    });
    expect(appointment.patientMrn).toMatch(/^AP-/);
    expect(await audited(hospital, appointment.id)).toEqual(['create']);
    const [event] = await events(hospital, appointment.id);
    expect(event?.event).toBe('appointment.created');
    expect(event?.payload).toEqual({
      appointmentId: appointment.id,
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: appointment.startsAt,
    });
  });

  it('answers a repeat with the same key from the appointment, booking nothing', async () => {
    const key = randomUUID();
    const body = { patientId: patients.one, doctorId: doctors.a, startsAt: at(tomorrow, '10:00') };
    const first = await book(body, { key });
    const again = await book(body, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Appointment>().id).toBe(first.json<Appointment>().id);
    expect(again.json<Appointment>().patientName).toBe('Priya Sharma');
    // Showing the record again is a read; nothing was booked a second time.
    expect(await audited(hospital, again.json<Appointment>().id)).toEqual(['create', 'read']);
    const { rows } = await pool.query('select id from appointments where tenant_id = $1', [
      hospital.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(errorOf(await book({ ...body, reason: 'Other' }, { key }))).toEqual([
      422,
      'idempotency_key_reuse',
    ]);
  });

  it('refuses a booking without an idempotency key', async () => {
    const response = await book(
      { patientId: patients.one, doctorId: doctors.a, startsAt: at(tomorrow, '10:00') },
      { key: null },
    );
    expect(errorOf(response)).toEqual([400, 'validation_failed']);
  });

  it('keeps a reason of several lines as it was typed, tidied line by line', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '10:00'),
      reason: 'Fever  for three days\r\nCough at night ',
    });
    expect(appointment.reason).toBe('Fever for three days\nCough at night');
    const cancelled = await post(`/appointments/${appointment.id}/cancel`, {
      version: 1,
      reason: 'other',
      note: 'Called to say\nwill come next week',
    });
    expect(cancelled.json<Appointment>().cancellation).toEqual({
      reason: 'other',
      note: 'Called to say\nwill come next week',
    });
  });

  it('refuses a doctor whose membership the hospital suspended', async () => {
    await pool.query(
      "update memberships set status = 'suspended' where user_id = $1 and tenant_id = $2",
      [docB.id, hospital.id],
    );
    try {
      const response = await book({
        patientId: patients.one,
        doctorId: doctors.b,
        startsAt: at(tomorrow, '09:00'),
      });
      expect(errorOf(response)).toEqual([422, 'unknown_doctor']);
    } finally {
      await pool.query(
        "update memberships set status = 'active' where user_id = $1 and tenant_id = $2",
        [docB.id, hospital.id],
      );
    }
  });

  it('refuses times that are not a slot, have started, or are too far ahead', async () => {
    for (const startsAt of [
      at(tomorrow, '09:05'),
      at(tomorrow, '08:45'),
      at(tomorrow, '13:00'),
      '2020-01-01T03:30:00.000Z',
      at('2099-01-01', '09:00'),
    ]) {
      const response = await book({ patientId: patients.one, doctorId: doctors.a, startsAt });
      expect(errorOf(response)).toEqual([422, 'outside_hours']);
    }
  });

  it('refuses an unknown patient or doctor, whichever hospital it belongs to', async () => {
    const startsAt = at(tomorrow, '09:00');
    for (const patientId of [patients.clinic, randomUUID(), 'x']) {
      const response = await book({ patientId, doctorId: doctors.a, startsAt });
      expect(errorOf(response)).toEqual([422, 'unknown_patient']);
    }
    for (const doctorId of [doctors.c, doctors.inactive, randomUUID()]) {
      const response = await book({ patientId: patients.one, doctorId, startsAt });
      expect(errorOf(response)).toEqual([422, 'unknown_doctor']);
    }
  });

  it('refuses any part of extensions, since no feature registers one', async () => {
    const body = { patientId: patients.one, doctorId: doctors.a, startsAt: at(tomorrow, '09:00') };
    expect(errorOf(await book({ ...body, extensions: { reminders: { sms: true } } }))).toEqual([
      422,
      'unknown_extension',
    ]);
    expect((await book({ ...body, extensions: {} })).statusCode).toBe(201);
  });

  it('refuses a reason that is not plain text', async () => {
    const response = await book({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
      reason: 'a\u0000b',
    });
    expect(errorOf(response)).toEqual([400, 'validation_failed']);
  });

  it('refuses a held time for the doctor and an overlapping time for the patient', async () => {
    const startsAt = at(tomorrow, '11:00');
    await booked({ patientId: patients.one, doctorId: doctors.a, startsAt });
    expect(errorOf(await book({ patientId: patients.two, doctorId: doctors.a, startsAt }))).toEqual(
      [409, 'slot_taken'],
    );
    expect(errorOf(await book({ patientId: patients.one, doctorId: doctors.b, startsAt }))).toEqual(
      [409, 'patient_overlap'],
    );
  });

  it('never double books, however many requests come at once', async () => {
    const startsAt = at(tomorrow, '12:00');
    // A different patient each, so the doctor's time is the only thing they compete for.
    const responses = await Promise.all(
      crowd.map((patientId) => book({ patientId, doctorId: doctors.a, startsAt })),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(response.json().error.code).toBe('slot_taken');
    }
    const { rows } = await pool.query(
      "select id from appointments where doctor_id = $1 and status = 'scheduled'",
      [doctors.a],
    );
    expect(rows).toHaveLength(1);
  });

  it('never books one patient twice at once with two doctors', async () => {
    const startsAt = at(tomorrow, '12:30');
    const responses = await Promise.all(
      [doctors.a, doctors.b, doctors.a, doctors.b].map((doctorId) =>
        book({ patientId: patients.two, doctorId, startsAt }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    const { rows } = await pool.query(
      "select id from appointments where patient_id = $1 and status = 'scheduled'",
      [patients.two],
    );
    expect(rows).toHaveLength(1);
  });

  it('needs appointment:create, and the module switched on', async () => {
    const body = { patientId: patients.one, doctorId: doctors.a, startsAt: at(tomorrow, '09:00') };
    expect(errorOf(await book(body, { user: docA }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await book(body, { user: nurse }))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await book(
          { patientId: patients.closed, doctorId: doctors.closed, startsAt: at(tomorrow, '09:00') },
          { tenant: closed },
        ),
      ),
    ).toEqual([403, 'feature_disabled']);
  });
});

describe('the list and one appointment', () => {
  it('lists the days at the hospital by start, a page at a time, with the total first', async () => {
    const ids: string[] = [];
    for (const [time, patientId] of [
      ['09:00', patients.one],
      ['09:15', patients.two],
      ['09:30', patients.three],
    ] as const) {
      ids.push((await booked({ patientId, doctorId: doctors.a, startsAt: at(tomorrow, time) })).id);
    }
    await booked({ patientId: patients.one, doctorId: doctors.b, startsAt: at(tomorrow, '10:00') });
    const first = await get(
      `/appointments?from=${tomorrow}&to=${tomorrow}&doctorId=${doctors.a}&limit=2`,
    );
    expect(first.statusCode).toBe(200);
    const page = first.json<Page<Appointment>>();
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(page.total).toBe(3);
    expect(page.items[0]).not.toHaveProperty('reason');
    const second = (
      await get(
        `/appointments?from=${tomorrow}&to=${tomorrow}&doctorId=${doctors.a}&limit=2&cursor=${page.nextCursor}`,
      )
    ).json<Page<Appointment>>();
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
    expect(second).not.toHaveProperty('total');
    // Every row shown is a record read.
    expect(await audited(hospital, ids[0] ?? '')).toEqual(['create', 'read']);

    const all = (await get(`/appointments?from=${tomorrow}&to=${tomorrow}`)).json<
      Page<Appointment>
    >();
    expect(all.total).toBe(4);
    const cancelledNone = (
      await get(`/appointments?from=${tomorrow}&to=${tomorrow}&status=cancelled`)
    ).json<Page<Appointment>>();
    expect(cancelledNone.items).toEqual([]);
    const scheduled = (
      await get(`/appointments?from=${tomorrow}&to=${tomorrow}&status=scheduled`)
    ).json<Page<Appointment>>();
    expect(scheduled.total).toBe(4);
  });

  it('pages through appointments that start at the same time, by id', async () => {
    const both = [
      await booked({
        patientId: patients.one,
        doctorId: doctors.a,
        startsAt: at(tomorrow, '09:00'),
      }),
      await booked({
        patientId: patients.two,
        doctorId: doctors.b,
        startsAt: at(tomorrow, '09:00'),
      }),
    ]
      .map((appointment) => appointment.id)
      .sort();
    const url = `/appointments?from=${tomorrow}&to=${tomorrow}&limit=1`;
    const first = (await get(url)).json<Page<Appointment>>();
    const second = (await get(`${url}&cursor=${first.nextCursor}`)).json<Page<Appointment>>();
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(both);
    expect(second.nextCursor).toBeNull();
  });

  it('takes the day boundaries from the hospital’s timezone', async () => {
    // 23:30 tomorrow at the hospital (18:00 UTC) is tomorrow; 00:15 the day after (18:45 UTC
    // tomorrow) is not, though both fall on tomorrow in UTC.
    await inserted(hospital, patients.one, doctors.a, at(tomorrow, '23:30'));
    const dayAfter = new Date(Date.parse(`${tomorrow}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    await inserted(hospital, patients.two, doctors.a, at(dayAfter, '00:15'));
    const page = (await get(`/appointments?from=${tomorrow}&to=${tomorrow}`)).json<
      Page<Appointment>
    >();
    expect(page.items.map((item) => item.startsAt)).toEqual([at(tomorrow, '23:30')]);
  });

  it('refuses a range that is not one, longer than 31 days, or a bad cursor', async () => {
    for (const query of [
      'from=2026-03-02&to=2026-03-01',
      'from=2026-01-01&to=2026-02-01',
      'from=2026-02-30&to=2026-03-01',
    ]) {
      expect(errorOf(await get(`/appointments?${query}`))).toEqual([400, 'validation_failed']);
    }
    expect((await get('/appointments?from=2026-01-01&to=2026-01-31')).statusCode).toBe(200);
    expect(
      errorOf(await get(`/appointments?from=${tomorrow}&to=${tomorrow}&cursor=bogus`)),
    ).toEqual([400, 'invalid_cursor']);
  });

  it('gives one appointment with its reason, audited', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
      reason: 'Cough',
    });
    const response = await get(`/appointments/${appointment.id}`, { user: nurse });
    expect(response.statusCode).toBe(200);
    expect(response.json<Appointment>().reason).toBe('Cough');
    expect(await audited(hospital, appointment.id)).toEqual(['create', 'read']);
    for (const id of [randomUUID(), 'not-an-id']) {
      expect(errorOf(await get(`/appointments/${id}`))).toEqual([404, 'appointment_not_found']);
    }
  });

  it('applies the scope of appointment:read: own and department', async () => {
    const mine = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const theirs = await booked({
      patientId: patients.two,
      doctorId: doctors.b,
      startsAt: at(tomorrow, '09:00'),
    });
    const list = (options: Options, extra = '') =>
      get(`/appointments?from=${tomorrow}&to=${tomorrow}${extra}`, options);
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and role_id = 'doctor' and permission = 'appointment:read'`,
        [hospital.id, scope],
      );
    try {
      // The default: the whole hospital.
      expect((await list({ user: docA })).json<Page<Appointment>>().total).toBe(2);
      await setScope('own');
      const own = (await list({ user: docA })).json<Page<Appointment>>();
      expect(own.items.map((item) => item.id)).toEqual([mine.id]);
      expect(own.total).toBe(1);
      // Asking for another doctor gives an empty page, not a refusal.
      const other = await list({ user: docA }, `&doctorId=${doctors.b}`);
      expect(other.statusCode).toBe(200);
      expect(other.json<Page<Appointment>>().items).toEqual([]);
      expect(errorOf(await get(`/appointments/${theirs.id}`, { user: docA }))).toEqual([
        404,
        'appointment_not_found',
      ]);
      await setScope('department');
      expect(
        (await list({ user: docB })).json<Page<Appointment>>().items.map((item) => item.id),
      ).toEqual([theirs.id]);
    } finally {
      await setScope('all');
    }
  });

  it('needs appointment:read', async () => {
    expect(
      errorOf(await get(`/appointments?from=${tomorrow}&to=${tomorrow}`, { user: storeKeeper })),
    ).toEqual([403, 'permission_denied']);
  });
});

describe('changes', () => {
  it('moves an appointment to another doctor’s free time, announced with both starts', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const response = await post(`/appointments/${appointment.id}/reschedule`, {
      version: 1,
      doctorId: doctors.b,
      startsAt: at(tomorrow, '10:30'),
      reason: 'doctor_unavailable',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Appointment>()).toMatchObject({
      id: appointment.id,
      doctorId: doctors.b,
      startsAt: at(tomorrow, '10:30'),
      endsAt: at(tomorrow, '10:45'),
      status: 'scheduled',
      version: 2,
    });
    const moved = (await events(hospital, appointment.id)).find(
      (event) => event.event === 'appointment.rescheduled',
    );
    expect(moved?.payload).toMatchObject({
      fromDoctorId: doctors.a,
      doctorId: doctors.b,
      fromStartsAt: at(tomorrow, '09:00'),
      startsAt: at(tomorrow, '10:30'),
      reason: 'doctor_unavailable',
    });
    expect(await audited(hospital, appointment.id)).toEqual(['create', 'update']);
  });

  it('moves within its own time, and refuses a held or overlapping one', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    await booked({ patientId: patients.two, doctorId: doctors.a, startsAt: at(tomorrow, '09:30') });
    await booked({ patientId: patients.one, doctorId: doctors.b, startsAt: at(tomorrow, '10:00') });
    const move = (startsAt: string, version: number, doctorId = doctors.a) =>
      post(`/appointments/${appointment.id}/reschedule`, {
        version,
        doctorId,
        startsAt,
        reason: 'other',
        note: 'Asked by phone',
      });
    // Its own time does not count against it.
    expect((await move(at(tomorrow, '09:00'), 1)).statusCode).toBe(200);
    expect(errorOf(await move(at(tomorrow, '09:30'), 2))).toEqual([409, 'slot_taken']);
    expect(errorOf(await move(at(tomorrow, '10:00'), 2))).toEqual([409, 'patient_overlap']);
    expect(errorOf(await move(at(tomorrow, '09:10'), 2))).toEqual([422, 'outside_hours']);
    expect(errorOf(await move(at(tomorrow, '11:00'), 2, doctors.inactive))).toEqual([
      422,
      'unknown_doctor',
    ]);
    expect(
      errorOf(
        await post(`/appointments/${appointment.id}/reschedule`, {
          version: 2,
          doctorId: doctors.a,
          startsAt: at(tomorrow, '11:00'),
          reason: 'other',
        }),
      ),
    ).toEqual([400, 'validation_failed']);
  });

  it('cancels with a reason, frees the time, and is final', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const response = await post(`/appointments/${appointment.id}/cancel`, {
      version: 1,
      reason: 'other',
      note: ' Travelling ',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Appointment>()).toMatchObject({
      status: 'cancelled',
      version: 2,
      cancellation: { reason: 'other', note: 'Travelling' },
    });
    // The time is free for another patient.
    await booked({ patientId: patients.two, doctorId: doctors.a, startsAt: at(tomorrow, '09:00') });
    for (const [path, body] of [
      ['cancel', { version: 2, reason: 'duplicate' }],
      ['complete', { version: 2 }],
      [
        'reschedule',
        { version: 2, doctorId: doctors.a, startsAt: at(tomorrow, '11:00'), reason: 'hospital' },
      ],
    ] as const) {
      expect(errorOf(await post(`/appointments/${appointment.id}/${path}`, body))).toEqual([
        409,
        'invalid_transition',
      ]);
    }
    expect((await events(hospital, appointment.id)).map((event) => event.event)).toEqual([
      'appointment.created',
      'appointment.cancelled',
    ]);
  });

  it('refuses a change made from an old version', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    await post(`/appointments/${appointment.id}/reschedule`, {
      version: 1,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:45'),
      reason: 'hospital',
    });
    expect(
      errorOf(
        await post(`/appointments/${appointment.id}/cancel`, { version: 1, reason: 'hospital' }),
      ),
    ).toEqual([409, 'conflict']);
  });

  it('completes or marks a no-show once started, not before; cancels only until it ends', async () => {
    const future = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    expect(errorOf(await post(`/appointments/${future.id}/complete`, { version: 1 }))).toEqual([
      422,
      'too_early',
    ]);
    expect(errorOf(await post(`/appointments/${future.id}/no-show`, { version: 1 }))).toEqual([
      422,
      'too_early',
    ]);
    const now = Date.now();
    const started = await inserted(
      hospital,
      patients.two,
      doctors.a,
      new Date(now - 5 * 60_000).toISOString(),
    );
    const ended = await inserted(
      hospital,
      patients.three,
      doctors.a,
      new Date(now - 60 * 60_000).toISOString(),
    );
    expect(
      errorOf(await post(`/appointments/${ended}/cancel`, { version: 1, reason: 'hospital' })),
    ).toEqual([422, 'too_late']);
    const completed = await post(`/appointments/${started}/complete`, { version: 1 });
    expect(completed.json<Appointment>().status).toBe('completed');
    const [done] = await events(hospital, started);
    expect(done).toEqual({
      event: 'appointment.completed',
      payload: { appointmentId: started, patientId: patients.two, doctorId: doctors.a },
    });
    const noShow = await post(`/appointments/${ended}/no-show`, { version: 1 });
    expect(noShow.json<Appointment>().status).toBe('no_show');
    expect((await events(hospital, ended)).map((event) => event.event)).toEqual([
      'appointment.no_show',
    ]);
  });

  it('lets one of two changes made at once through', async () => {
    const started = await inserted(
      hospital,
      patients.one,
      doctors.a,
      new Date(Date.now() - 5 * 60_000).toISOString(),
    );
    const responses = await Promise.all([
      post(`/appointments/${started}/cancel`, { version: 1, reason: 'hospital' }),
      post(`/appointments/${started}/complete`, { version: 1 }),
      post(`/appointments/${started}/no-show`, { version: 1 }),
    ]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    for (const response of responses.filter((r) => r.statusCode !== 200)) {
      expect(['invalid_transition', 'conflict']).toContain(response.json().error.code);
    }
    expect(await events(hospital, started)).toHaveLength(1);
  });

  it('answers a repeated change from the appointment as it is, changing nothing', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const key = randomUUID();
    const body = { version: 1, reason: 'patient_request' };
    await post(`/appointments/${appointment.id}/cancel`, body, { key });
    const again = await post(`/appointments/${appointment.id}/cancel`, body, { key });
    expect(again.statusCode).toBe(200);
    expect(again.json<Appointment>()).toMatchObject({ status: 'cancelled', version: 2 });
    expect((await events(hospital, appointment.id)).map((event) => event.event)).toEqual([
      'appointment.created',
      'appointment.cancelled',
    ]);
    // The repeat changed nothing, but it showed the record again: a read.
    expect(await audited(hospital, appointment.id)).toEqual(['create', 'update', 'read']);
  });

  it('applies the scope of appointment:update, to the appointment and to where it moves', async () => {
    const mine = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const theirs = await booked({
      patientId: patients.two,
      doctorId: doctors.b,
      startsAt: at(tomorrow, '09:00'),
    });
    const grant = (scope: string) =>
      pool.query(
        `insert into role_permissions (tenant_id, role_id, permission, scope)
         values ($1, 'doctor', 'appointment:update', $2)
         on conflict (tenant_id, role_id, permission) do update set scope = excluded.scope`,
        [hospital.id, scope],
      );
    const move = (id: string, doctorId: string, version = 1) =>
      post(
        `/appointments/${id}/reschedule`,
        { version, doctorId, startsAt: at(tomorrow, '11:00'), reason: 'hospital' },
        { user: docA },
      );
    try {
      for (const scope of ['own', 'department']) {
        await grant(scope);
        expect(errorOf(await move(theirs.id, doctors.b))).toEqual([404, 'appointment_not_found']);
        // Not to a doctor outside the scope, where the caller could no longer see it.
        expect(errorOf(await move(mine.id, doctors.b))).toEqual([422, 'unknown_doctor']);
      }
      expect((await move(mine.id, doctors.a)).statusCode).toBe(200);
    } finally {
      await pool.query(
        `delete from role_permissions
         where tenant_id = $1 and role_id = 'doctor' and permission = 'appointment:update'`,
        [hospital.id],
      );
    }
  });

  it('needs appointment:update, and answers 404 for another hospital’s appointment', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    expect(
      errorOf(
        await post(
          `/appointments/${appointment.id}/cancel`,
          { version: 1, reason: 'hospital' },
          {
            user: docA,
          },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await post(
          `/appointments/${appointment.id}/cancel`,
          { version: 1, reason: 'hospital' },
          {
            tenant: clinic,
          },
        ),
      ),
    ).toEqual([404, 'appointment_not_found']);
    expect(errorOf(await get(`/appointments/${appointment.id}`, { tenant: clinic }))).toEqual([
      404,
      'appointment_not_found',
    ]);
  });
});

describe('the hospital boundary in the database', () => {
  it('shows no hospital another’s appointments and lets none write one', async () => {
    const appointment = await booked({
      patientId: patients.one,
      doctorId: doctors.a,
      startsAt: at(tomorrow, '09:00'),
    });
    const atClinic = await get(`/appointments?from=${tomorrow}&to=${tomorrow}`, { tenant: clinic });
    expect(atClinic.json<Page<Appointment>>().items).toEqual([]);
    await asTenantSql(pool, clinic.id, async (client) => {
      const { rows } = await client.query('select id from appointments');
      expect(rows).toEqual([]);
      const updated = await client.query("update appointments set reason = 'x' where id = $1", [
        appointment.id,
      ]);
      expect(updated.rowCount).toBe(0);
    });
    // Writing a row for another hospital, or pointing at another hospital's patient or doctor.
    for (const [tenantId, patientId, doctorId] of [
      [hospital.id, patients.one, doctors.a],
      [clinic.id, patients.one, doctors.c],
      [clinic.id, patients.clinic, doctors.a],
    ]) {
      await expect(
        asTenantSql(pool, clinic.id, (client) =>
          client.query(
            `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, created_by)
             values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 15 minutes', 'x')`,
            [tenantId, patientId, doctorId],
          ),
        ),
      ).rejects.toThrow();
    }
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('delete from appointments')).rejects.toThrow();
    });
  });

  it('refuses a change of a final appointment, whatever the application does', async () => {
    const id = await inserted(hospital, patients.one, doctors.a, at(tomorrow, '09:00'));
    await pool.query("update appointments set status = 'completed' where id = $1", [id]);
    await expect(
      pool.query("update appointments set status = 'scheduled' where id = $1", [id]),
    ).rejects.toThrow(/final/);
  });
});
