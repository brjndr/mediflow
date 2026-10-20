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
 * Referrals and follow-ups (#88) through the real app and database: referring to a department or
 * a doctor and cancelling it; a follow-up set from the consultation, the due list, booking it as
 * a linked appointment, due again when that appointment is cancelled; the hospital boundary,
 * the module switches, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Clinical on, appointments off. */
let noBooking: TestTenant;
let doctor: TestUser;
let colleague: TestUser;
let nurse: TestUser;
let desk: TestUser;
let clinicDoctor: TestUser;
const departments = { general: '', ortho: '', archived: '', clinic: '' };
const doctors = { doctor: '', colleague: '', clinic: '', noBooking: '' };
const patients = { asha: '', clinic: '', noBooking: '' };

interface Referral {
  id: string;
  departmentId: string;
  departmentName: string;
  doctorId?: string;
  doctorName?: string;
  urgency: string;
  reason: string;
  cancelledAt?: string;
  cancelReason?: string;
}
interface FollowUp {
  id: string;
  encounterId: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  doctorId: string;
  dueOn: string;
  note?: string;
  state: string;
  appointmentId?: string;
  appointmentStartsAt?: string;
  version: number;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  /** The idempotency key; a new one when absent. */
  key?: string;
}
type Reply = {
  statusCode: number;
  body: string;
  json: <T = { error: { code: string } }>() => T;
};

const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? doctor).id) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      ...as((options.tenant ?? hospital).id, (options.user ?? doctor).id),
      'idempotency-key': options.key ?? randomUUID(),
    },
    payload: body,
  });
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function ok<T>(response: Promise<Reply> | Reply, status = 201): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

const open = async (patientId = patients.asha, options: Options = {}) =>
  (await ok<{ id: string }>(post('/encounters', { patientId }, options))).id;
const refer = (encounterId: string, body: object, options: Options = {}) =>
  post(
    `/encounters/${encounterId}/referrals`,
    { urgency: 'routine', reason: 'Knee pain', ...body },
    options,
  );
const plan = (encounterId: string, body: object, options: Options = {}) =>
  post(`/encounters/${encounterId}/follow-ups`, body, options);

/** A day at the hospital (Asia/Kolkata), so many days from today. */
const day = async (offset: number) =>
  (
    await pool.query<{ day: string }>(
      "select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text as day",
      [offset],
    )
  ).rows[0]?.day ?? '';

/** The first free slot of the doctor on that day. */
async function slotOn(doctorId: string, onDay: string, options: Options = {}) {
  const free = await ok<{ slots: { startsAt: string }[] }>(
    get(`/appointments/free-slots?doctorId=${doctorId}&day=${onDay}`, {
      user: desk,
      ...options,
    }),
    200,
  );
  const first = free.slots[0];
  if (!first) throw new Error('no free slot');
  return first.startsAt;
}

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log
       where tenant_id = $1 and entity = $2 and entity_id = $3 order by at`,
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const events = async (entityId: string) =>
  (
    await pool.query<{ event: string; payload: Record<string, unknown> }>(
      'select event, payload from outbox where tenant_id = $1 and entity_id = $2 order by occurred_at',
      [hospital.id, entityId],
    )
  ).rows;

const tenants = () => [hospital.id, clinic.id, noBooking.id];

const clear = async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of ['follow_ups', 'referrals', 'encounters', 'appointments', 'outbox']) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
};

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `RF-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function addDepartment(tenant: TestTenant, name: string, archived = false) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name, archived) values ($1, $2, $3) returning id',
    [tenant.id, name, archived],
  );
  return rows[0]?.id ?? '';
}

/** A profile working 09:00 to 13:00 every day, in 15-minute appointments. */
async function addDoctor(tenant: TestTenant, user: TestUser, departmentId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15) returning id`,
    [tenant.id, user.id, departmentId],
  );
  const id = rows[0]?.id ?? '';
  await pool.query(
    `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
     select $1, $2, day, 540, 780 from generate_series(1, 7) as day`,
    [tenant.id, id],
  );
  return id;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { clinical: true, patients: true, appointments: true };
  hospital = await createTenant(pool, 'Referral Hospital', { features });
  clinic = await createTenant(pool, 'Referral Clinic', { features });
  noBooking = await createTenant(pool, 'Referral No Booking', {
    features: { ...features, appointments: false },
  });
  for (const tenant of [hospital, clinic, noBooking]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  doctor = await user('Referral Doctor');
  colleague = await user('Referral Colleague');
  nurse = await user('Referral Nurse');
  desk = await user('Referral Desk');
  clinicDoctor = await user('Referral Clinic Doctor');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, noBooking, 'doctor');
  await addMembership(pool, colleague, hospital, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, desk, noBooking, 'receptionist');
  await addMembership(pool, clinicDoctor, clinic, 'doctor');
  departments.general = await addDepartment(hospital, 'General');
  departments.ortho = await addDepartment(hospital, 'Orthopaedics');
  departments.archived = await addDepartment(hospital, 'Closed Ward', true);
  departments.clinic = await addDepartment(clinic, 'General');
  const noBookingDepartment = await addDepartment(noBooking, 'General');
  doctors.doctor = await addDoctor(hospital, doctor, departments.general);
  doctors.colleague = await addDoctor(hospital, colleague, departments.ortho);
  doctors.clinic = await addDoctor(clinic, clinicDoctor, departments.clinic);
  doctors.noBooking = await addDoctor(noBooking, doctor, noBookingDepartment);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.clinic = await addPatient(clinic, 'Dina');
  patients.noBooking = await addPatient(noBooking, 'Esha');
});

afterEach(clear);

afterAll(async () => {
  await clear();
  for (const table of ['doctor_hours', 'doctors', 'patients', 'departments']) {
    await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
  }
  await deleteUsers(pool, [doctor, colleague, nurse, desk, clinicDoctor]);
  await deleteTenants(pool, [hospital, clinic, noBooking]);
  await app.close();
});

describe('referrals', () => {
  it('refers to a department, or to a doctor whose department it takes, audited with an event of ids', async () => {
    const encounterId = await open();
    const toDepartment = await ok<Referral>(
      refer(encounterId, { departmentId: departments.ortho }),
    );
    expect(toDepartment).toMatchObject({
      departmentId: departments.ortho,
      departmentName: 'Orthopaedics',
      urgency: 'routine',
      reason: 'Knee pain',
    });
    expect(toDepartment.doctorId).toBeUndefined();

    const toDoctor = await ok<Referral>(
      refer(encounterId, {
        doctorId: doctors.colleague,
        urgency: 'urgent',
        reason: '  Swelling\nfor a week ',
      }),
    );
    expect(toDoctor).toMatchObject({
      departmentId: departments.ortho,
      doctorId: doctors.colleague,
      doctorName: 'Referral Colleague',
      urgency: 'urgent',
      reason: 'Swelling\nfor a week',
    });

    const page = await ok<Page<Referral>>(get(`/encounters/${encounterId}/referrals`), 200);
    expect(page.items.map((item) => item.id)).toEqual([toDepartment.id, toDoctor.id]);
    expect(await audited('referral', toDoctor.id)).toEqual(['create', 'read']);
    const [event] = await events(toDoctor.id);
    expect(event?.event).toBe('referral.created');
    expect(event?.payload).toEqual({
      referralId: toDoctor.id,
      encounterId,
      patientId: patients.asha,
      departmentId: departments.ortho,
      doctorId: doctors.colleague,
      urgency: 'urgent',
    });
  });

  it('refuses a referral to nobody, an unknown or archived department, or a doctor of another one', async () => {
    const encounterId = await open();
    expect(errorOf(await refer(encounterId, {}))).toEqual([400, 'validation_failed']);
    expect(errorOf(await refer(encounterId, { departmentId: departments.archived }))).toEqual([
      422,
      'unknown_department',
    ]);
    expect(errorOf(await refer(encounterId, { departmentId: departments.clinic }))).toEqual([
      422,
      'unknown_department',
    ]);
    expect(errorOf(await refer(encounterId, { doctorId: doctors.clinic }))).toEqual([
      422,
      'unknown_doctor',
    ]);
    expect(
      errorOf(
        await refer(encounterId, {
          departmentId: departments.general,
          doctorId: doctors.colleague,
        }),
      ),
    ).toEqual([422, 'doctor_not_in_department']);
    expect(
      errorOf(await refer(encounterId, { departmentId: departments.ortho, reason: 'a\u0000b' })),
    ).toEqual([400, 'validation_failed']);
  });

  it('is cancelled once with a reason, after the encounter closed too, and then keeps the encounter from being cancelled', async () => {
    const encounterId = await open();
    const referral = await ok<Referral>(refer(encounterId, { departmentId: departments.ortho }));
    expect(
      errorOf(
        await post(`/encounters/${encounterId}/cancel`, { reason: 'Wrong patient', version: 1 }),
      ),
    ).toEqual([409, 'has_records']);
    await ok(post(`/encounters/${encounterId}/close`, { version: 1 }), 200);
    const cancelled = await ok<Referral>(
      post(`/referrals/${referral.id}/cancel`, { reason: 'Not needed' }),
      200,
    );
    expect(cancelled).toMatchObject({ cancelReason: 'Not needed' });
    expect(cancelled.cancelledAt).toBeDefined();
    expect(errorOf(await post(`/referrals/${referral.id}/cancel`, { reason: 'Again' }))).toEqual([
      409,
      'already_cancelled',
    ]);
    expect((await events(referral.id)).map((event) => event.event)).toEqual([
      'referral.created',
      'referral.cancelled',
    ]);
    // A closed encounter takes no new referral.
    expect(errorOf(await refer(encounterId, { departmentId: departments.ortho }))).toEqual([
      409,
      'encounter_not_open',
    ]);
  });

  it('is behind its permissions, and another hospital’s is not found', async () => {
    const encounterId = await open();
    const referral = await ok<Referral>(refer(encounterId, { departmentId: departments.ortho }));
    expect(errorOf(await get(`/encounters/${encounterId}/referrals`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(await refer(encounterId, { departmentId: departments.ortho }, { user: desk })),
    ).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await post(
          `/referrals/${referral.id}/cancel`,
          { reason: 'x' },
          {
            tenant: clinic,
            user: clinicDoctor,
          },
        ),
      ),
    ).toEqual([404, 'referral_not_found']);
    expect(
      errorOf(
        await get(`/encounters/${encounterId}/referrals`, { tenant: clinic, user: clinicDoctor }),
      ),
    ).toEqual([404, 'encounter_not_found']);
  });
});

describe('follow-ups', () => {
  it('asks the patient back to the encounter’s doctor, once per encounter, from today to a year ahead', async () => {
    const encounterId = await open();
    const dueOn = await day(7);
    const followUp = await ok<FollowUp>(plan(encounterId, { dueOn, note: 'With the reports' }));
    expect(followUp).toMatchObject({
      encounterId,
      patientId: patients.asha,
      patientName: 'Asha Test',
      doctorId: doctors.doctor,
      dueOn,
      note: 'With the reports',
      state: 'due',
      version: 1,
    });
    expect(followUp.appointmentId).toBeUndefined();
    expect(errorOf(await plan(encounterId, { dueOn }))).toEqual([409, 'follow_up_exists']);
    const [event] = await events(followUp.id);
    expect(event?.payload).toEqual({
      followUpId: followUp.id,
      encounterId,
      patientId: patients.asha,
      doctorId: doctors.doctor,
      dueOn,
    });

    const other = await open();
    expect(errorOf(await plan(other, { dueOn: await day(-1) }))).toEqual([422, 'outside_window']);
    expect(errorOf(await plan(other, { dueOn: await day(400) }))).toEqual([422, 'outside_window']);
    expect(errorOf(await plan(other, { dueOn, doctorId: doctors.clinic }))).toEqual([
      422,
      'unknown_doctor',
    ]);
    expect(errorOf(await plan(other, { dueOn: '2026-02-30' }))).toEqual([400, 'validation_failed']);
    expect(
      await ok<FollowUp>(plan(other, { dueOn: await day(0), doctorId: doctors.colleague })),
    ).toMatchObject({ doctorId: doctors.colleague });
  });

  it('lists what is due for the front desk, the soonest first, filtered by state, days and doctor', async () => {
    const later = await ok<FollowUp>(plan(await open(), { dueOn: await day(10) }));
    const sooner = await ok<FollowUp>(plan(await open(), { dueOn: await day(3) }));
    const other = await ok<FollowUp>(
      plan(await open(), { dueOn: await day(5), doctorId: doctors.colleague }),
    );
    const page = await ok<Page<FollowUp>>(get('/follow-ups?state=due', { user: desk }), 200);
    expect(page.items.map((item) => item.id)).toEqual([sooner.id, other.id, later.id]);
    // A whole hospital is not counted; one doctor's is.
    expect(page.total).toBeUndefined();
    expect(page.items[0]?.patientMrn).toMatch(/^RF-/);
    const ranged = await ok<Page<FollowUp>>(
      get(`/follow-ups?dueFrom=${await day(4)}&dueTo=${await day(10)}&doctorId=${doctors.doctor}`, {
        user: desk,
      }),
      200,
    );
    expect(ranged.items.map((item) => item.id)).toEqual([later.id]);
    const paged = await ok<Page<FollowUp>>(get('/follow-ups?limit=2', { user: desk }), 200);
    expect(paged.items).toHaveLength(2);
    const rest = await ok<Page<FollowUp>>(
      get(`/follow-ups?limit=2&cursor=${paged.nextCursor ?? ''}`, { user: desk }),
      200,
    );
    expect(rest.items.map((item) => item.id)).toEqual([later.id]);
    expect(await audited('follow_up', sooner.id)).toContain('read');
    // Another hospital sees none of them.
    const theirs = await ok<Page<FollowUp>>(
      get('/follow-ups', { tenant: clinic, user: clinicDoctor }),
      200,
    );
    expect(theirs.items).toEqual([]);
    expect(errorOf(await get('/follow-ups?cursor=nope', { user: desk }))).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('is booked from the due list as an appointment it names, and is due again when that is cancelled', async () => {
    const encounterId = await open();
    const followUp = await ok<FollowUp>(plan(encounterId, { dueOn: await day(1) }));
    // Booked after the consultation is over, as at the front desk.
    await ok(post(`/encounters/${encounterId}/close`, { version: 1 }), 200);
    const startsAt = await slotOn(doctors.doctor, await day(1));
    const booked = await ok<FollowUp>(
      post(`/follow-ups/${followUp.id}/book`, { startsAt, version: 1 }, { user: desk }),
      200,
    );
    expect(booked).toMatchObject({ state: 'booked', appointmentStartsAt: startsAt, version: 2 });
    const appointmentId = booked.appointmentId ?? '';
    const appointment = await ok<{ patientId: string; doctorId: string; status: string }>(
      get(`/appointments/${appointmentId}`, { user: desk }),
      200,
    );
    expect(appointment).toMatchObject({
      patientId: patients.asha,
      doctorId: doctors.doctor,
      status: 'scheduled',
    });
    expect((await events(appointmentId)).map((event) => event.event)).toEqual([
      'appointment.created',
    ]);
    expect((await events(followUp.id)).map((event) => event.event)).toEqual([
      'followup.created',
      'followup.booked',
    ]);
    expect(await audited('follow_up', followUp.id)).toContain('update');

    expect(
      errorOf(
        await post(`/follow-ups/${followUp.id}/book`, { startsAt, version: 2 }, { user: desk }),
      ),
    ).toEqual([409, 'invalid_transition']);
    expect(
      errorOf(await post(`/follow-ups/${followUp.id}/cancel`, { reason: 'x', version: 2 })),
    ).toEqual([409, 'invalid_transition']);

    await ok(
      post(
        `/appointments/${appointmentId}/cancel`,
        { reason: 'patient_request', version: 1 },
        { user: desk },
      ),
      200,
    );
    const again = await ok<Page<FollowUp>>(get('/follow-ups?state=due', { user: desk }), 200);
    expect(again.items.map((item) => item.id)).toEqual([followUp.id]);
    const rebooked = await ok<FollowUp>(
      post(
        `/follow-ups/${followUp.id}/book`,
        {
          startsAt: await slotOn(doctors.colleague, await day(2)),
          doctorId: doctors.colleague,
          version: 2,
        },
        { user: desk },
      ),
      200,
    );
    expect(rebooked.state).toBe('booked');
    expect(rebooked.appointmentId).not.toBe(appointmentId);
  });

  it('refuses a booking the appointments would refuse, a stale version, and nothing is linked', async () => {
    const followUp = await ok<FollowUp>(plan(await open(), { dueOn: await day(1) }));
    const startsAt = await slotOn(doctors.doctor, await day(1));
    expect(
      errorOf(
        await post(`/follow-ups/${followUp.id}/book`, { startsAt, version: 9 }, { user: desk }),
      ),
    ).toEqual([409, 'conflict']);
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/book`,
          { startsAt: `${await day(1)}T00:01:00.000Z`, version: 1 },
          { user: desk },
        ),
      ),
    ).toEqual([422, 'outside_hours']);
    // The nurse reads follow-ups but books no appointment.
    expect(
      errorOf(
        await post(`/follow-ups/${followUp.id}/book`, { startsAt, version: 1 }, { user: nurse }),
      ),
    ).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/book`,
          { startsAt, version: 1 },
          {
            tenant: clinic,
            user: clinicDoctor,
          },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    const still = await ok<Page<FollowUp>>(
      get(`/encounters/${followUp.encounterId}/follow-ups`),
      200,
    );
    expect(still.items[0]).toMatchObject({ state: 'due', version: 1 });
  });

  it('is cancelled while due, and the encounter may then set another', async () => {
    const encounterId = await open();
    const followUp = await ok<FollowUp>(plan(encounterId, { dueOn: await day(5) }));
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/cancel`,
          { reason: 'x', version: 1 },
          { user: desk },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
    const cancelled = await ok<FollowUp>(
      post(`/follow-ups/${followUp.id}/cancel`, { reason: 'Recovered', version: 1 }),
      200,
    );
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelReason: 'Recovered' });
    expect(await ok<FollowUp>(plan(encounterId, { dueOn: await day(6) }))).toMatchObject({
      state: 'due',
    });
    const listed = await ok<Page<FollowUp>>(get(`/encounters/${encounterId}/follow-ups`), 200);
    expect(listed.items.map((item) => item.state).sort()).toEqual(['cancelled', 'due']);
  });

  it('books nothing with appointments off, and nothing is reached with clinical off', async () => {
    const encounterId = await open(patients.noBooking, { tenant: noBooking });
    const followUp = await ok<FollowUp>(
      plan(encounterId, { dueOn: await day(1) }, { tenant: noBooking }),
    );
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/book`,
          { startsAt: `${await day(1)}T04:00:00.000Z`, version: 1 },
          { tenant: noBooking, user: desk },
        ),
      ),
    ).toEqual([403, 'feature_disabled']);
    await pool.query(
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'clinical'",
      [noBooking.id],
    );
    try {
      expect(errorOf(await get('/follow-ups', { tenant: noBooking, user: desk }))).toEqual([
        403,
        'feature_disabled',
      ]);
    } finally {
      await pool.query(
        "update tenant_features set enabled = true where tenant_id = $1 and feature = 'clinical'",
        [noBooking.id],
      );
    }
  });

  it('keeps each hospital’s referrals and follow-ups to itself under row-level security', async () => {
    const encounterId = await open();
    await ok(refer(encounterId, { departmentId: departments.ortho }));
    await ok(plan(encounterId, { dueOn: await day(2) }));
    const seen = await asTenantSql(pool, clinic.id, async (client) => [
      (await client.query('select id from referrals')).rowCount,
      (await client.query('select id from follow_ups')).rowCount,
    ]);
    expect(seen).toEqual([0, 0]);
    const own = await asTenantSql(pool, hospital.id, async (client) => [
      (await client.query('select id from referrals')).rowCount,
      (await client.query('select id from follow_ups')).rowCount,
    ]);
    expect(own).toEqual([1, 1]);
    // Nor can a hospital write one onto another's encounter.
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into follow_ups (tenant_id, encounter_id, patient_id, doctor_id, due_on, created_by)
           values ($1, $2, $3, $4, current_date, $5)`,
          [clinic.id, encounterId, patients.asha, doctors.clinic, clinicDoctor.id],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('what the reviews asked for', () => {
  /** Narrows a grant of the built-in doctor role at the hospital, for scope tests. */
  const restrict = (permission: string, scope: string) =>
    pool.query(
      `update role_permissions set scope = $3
       where tenant_id = $1 and permission = $2 and role_id = 'doctor'`,
      [hospital.id, permission, scope],
    );

  it('keeps a follow-up within the scope of each route’s permission', async () => {
    const mine = await ok<FollowUp>(plan(await open(), { dueOn: await day(3) }));
    const theirs = await ok<FollowUp>(
      plan(
        await open(patients.asha, { user: colleague }),
        { dueOn: await day(4) },
        {
          user: colleague,
        },
      ),
    );
    try {
      await restrict('followUp:read', 'own');
      const page = await ok<Page<FollowUp>>(get('/follow-ups'), 200);
      expect(page.items.map((item) => item.id)).toEqual([mine.id]);
      expect(errorOf(await get(`/encounters/${theirs.encounterId}/follow-ups`))).toEqual([
        404,
        'encounter_not_found',
      ]);
      await restrict('followUp:read', 'all');
      // Reads them all, but cancels only those of the encounters the caller attends.
      await restrict('followUp:create', 'own');
      expect(
        errorOf(await post(`/follow-ups/${theirs.id}/cancel`, { reason: 'x', version: 1 })),
      ).toEqual([404, 'follow_up_not_found']);
      expect(
        (
          await ok<FollowUp>(
            post(`/follow-ups/${mine.id}/cancel`, { reason: 'x', version: 1 }),
            200,
          )
        ).state,
      ).toBe('cancelled');
    } finally {
      await restrict('followUp:read', 'all');
      await restrict('followUp:create', 'all');
    }
  });

  it('refuses another hospital’s follow-up and the desk’s cancelling', async () => {
    const followUp = await ok<FollowUp>(plan(await open(), { dueOn: await day(3) }));
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/cancel`,
          { reason: 'x', version: 1 },
          {
            tenant: clinic,
            user: clinicDoctor,
          },
        ),
      ),
    ).toEqual([404, 'follow_up_not_found']);
    // The desk books follow-ups but does not take them back.
    expect(
      errorOf(
        await post(
          `/follow-ups/${followUp.id}/cancel`,
          { reason: 'x', version: 1 },
          { user: desk },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('answers a repeat with the record as it is now, and books once', async () => {
    const encounterId = await open();
    const dueOn = await day(1);
    const first = await ok<FollowUp>(plan(encounterId, { dueOn }, { key: 'repeat-create-1' }));
    const again = await ok<FollowUp>(plan(encounterId, { dueOn }, { key: 'repeat-create-1' }));
    expect(again.id).toBe(first.id);
    const startsAt = await slotOn(doctors.doctor, await day(1));
    const body = { startsAt, version: 1 };
    const booked = await ok<FollowUp>(
      post(`/follow-ups/${first.id}/book`, body, { user: desk, key: 'repeat-book-1' }),
      200,
    );
    const repeat = await ok<FollowUp>(
      post(`/follow-ups/${first.id}/book`, body, { user: desk, key: 'repeat-book-1' }),
      200,
    );
    expect(repeat).toMatchObject({ state: 'booked', appointmentId: booked.appointmentId });
    const { rows } = await pool.query('select id from appointments where patient_id = $1', [
      patients.asha,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('books one of two simultaneous bookings, and links one appointment', async () => {
    const followUp = await ok<FollowUp>(plan(await open(), { dueOn: await day(1) }));
    const day1 = await day(1);
    const [a, b] = [await slotOn(doctors.doctor, day1), await slotOn(doctors.colleague, day1)];
    const replies = await Promise.all([
      post(`/follow-ups/${followUp.id}/book`, { startsAt: a, version: 1 }, { user: desk }),
      post(
        `/follow-ups/${followUp.id}/book`,
        { startsAt: b, doctorId: doctors.colleague, version: 1 },
        { user: desk },
      ),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    const { rows } = await pool.query('select id from appointments where patient_id = $1', [
      patients.asha,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('is attended once its appointment is completed', async () => {
    const followUp = await ok<FollowUp>(plan(await open(), { dueOn: await day(1) }));
    const startsAt = await slotOn(doctors.doctor, await day(1));
    const booked = await ok<FollowUp>(
      post(`/follow-ups/${followUp.id}/book`, { startsAt, version: 1 }, { user: desk }),
      200,
    );
    await pool.query("update appointments set status = 'completed' where id = $1", [
      booked.appointmentId,
    ]);
    const page = await ok<Page<FollowUp>>(get('/follow-ups?state=attended'), 200);
    expect(page.items.map((item) => [item.id, item.state])).toEqual([[followUp.id, 'attended']]);
    expect((await ok<Page<FollowUp>>(get('/follow-ups?state=due'), 200)).items).toEqual([]);
  });

  it('lets the app change nothing of a referral or follow-up but their cancelling and booking', async () => {
    const encounterId = await open();
    const referral = await ok<Referral>(refer(encounterId, { departmentId: departments.ortho }));
    const followUp = await ok<FollowUp>(plan(encounterId, { dueOn: await day(2) }));
    const refused = (sql: string, values: unknown[]) =>
      expect(
        asTenantSql(pool, hospital.id, (client) => client.query(sql, values)),
      ).rejects.toMatchObject({ code: '42501' });
    await refused("update referrals set reason = 'Changed' where id = $1", [referral.id]);
    await refused('update follow_ups set due_on = due_on + 1 where id = $1', [followUp.id]);
    await ok(post(`/follow-ups/${followUp.id}/cancel`, { reason: 'x', version: 1 }), 200);
    await refused("update follow_ups set cancel_reason = 'Again' where id = $1", [followUp.id]);
  });
});
