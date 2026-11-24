import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * `GET /appointments/capacity` (#1126): today's OPD slots across doctors, booked and free, with
 * the queue's waiting and called tokens, in counts only, within each hospital and the caller's
 * scope.
 */

let app: FastifyInstance;
let pool: pg.Pool;
/** Asia/Kolkata, appointments and queue on. */
let hospital: TestTenant;
/** Asia/Dubai, appointments on and the queue off. */
let clinic: TestTenant;
/** Appointments switched off. */
let closed: TestTenant;
let desk: TestUser;
let docA: TestUser;
let docB: TestUser;
let storeKeeper: TestUser;
let clinicDoc: TestUser;
const ids = { a: '', b: '', c: '', general: '', surgery: '', clinicDept: '', patient: '' };
const patients: string[] = [];
let clinicPatient = '';

interface Capacity {
  day: string;
  slots: number;
  booked: number;
  free: number;
  waiting?: number;
  inConsult?: number;
}

/** Hours from 00:00 to 23:45 every day, in 15-minute slots: 95 slots a day. */
const START = 0;
const END = 1425;
const LENGTH = 15;
const PER_DAY = (END - START) / LENGTH;

const get = (tenant: TestTenant, user: TestUser) =>
  app.inject({ url: '/appointments/capacity', headers: as(tenant.id, user.id) });

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
     values ($1, $2, $3, 'General practice', $4) returning id`,
    [tenant.id, user.id, departmentId, LENGTH],
  );
  const id = rows[0]?.id ?? '';
  await pool.query(
    `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
     select $1, $2, day, $3, $4 from generate_series(1, 7) as day`,
    [tenant.id, id, START, END],
  );
  return id;
}

let mrn = 0;
async function addPatient(tenant: TestTenant) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Cap', 'Patient', '1980-01-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CP-${String(mrn).padStart(7, '0')}`],
  );
  return rows[0]?.id ?? '';
}

/** Today at the hospital, and the instant a minute of it starts. */
async function todayAt(timezone: string) {
  const { rows } = await pool.query<{ day: string }>(
    'select (now() at time zone $1)::date::text as day',
    [timezone],
  );
  const day = rows[0]?.day ?? '';
  const minuteOf = async (minute: number) =>
    (
      await pool.query<{ at: Date }>(
        `select ($1::date + make_interval(mins => $2))::timestamp at time zone $3 as at`,
        [day, minute, timezone],
      )
    ).rows[0]?.at ?? new Date(0);
  return { day, minuteOf };
}

async function appointment(
  tenant: TestTenant,
  doctorId: string,
  patientId: string,
  startsAt: Date,
  status = 'scheduled',
  minutes = LENGTH,
) {
  await pool.query(
    `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, status, created_by,
                               cancel_reason)
     values ($1, $2, $3, $4, $4::timestamptz + make_interval(mins => $5), $6, 'test',
             case when $6 = 'cancelled' then 'patient_request' end)`,
    [tenant.id, patientId, doctorId, startsAt, minutes, status],
  );
}

let number = 0;
async function token(
  tenant: TestTenant,
  day: string,
  departmentId: string,
  patientId: string,
  { doctorId = null, status = 'waiting' }: { doctorId?: string | null; status?: string } = {},
) {
  number += 1;
  await pool.query(
    `insert into queue_tokens (tenant_id, day, department_id, number, patient_id, issued_by,
                               doctor_id, status, called_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8 = 'waiting' then null else now() end)`,
    [tenant.id, day, departmentId, number, patientId, desk.id, doctorId, status],
  );
}

/** Slots of one doctor's day that have not started, less those held. */
async function freeOf(timezone: string, held: number[]) {
  const { minuteOf } = await todayAt(timezone);
  let free = 0;
  for (let minute = START; minute + LENGTH <= END; minute += LENGTH) {
    if (held.includes(minute)) continue;
    if ((await minuteOf(minute)).getTime() > Date.now()) free += 1;
  }
  return free;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { appointments: true, patients: true, doctors: true, departments: true };
  hospital = await createTenant(pool, 'Capacity Hospital', {
    features: { ...features, queue: true },
  });
  clinic = await createTenant(pool, 'Capacity Clinic', { features, timezone: 'Asia/Dubai' });
  closed = await createTenant(pool, 'Capacity Closed', {
    features: { ...features, appointments: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  desk = await user('Cap Desk');
  docA = await user('Cap Doctor A');
  docB = await user('Cap Doctor B');
  storeKeeper = await user('Cap Store');
  clinicDoc = await user('Cap Clinic Doctor');
  for (const tenant of [hospital, clinic, closed]) {
    await addMembership(pool, desk, tenant, 'receptionist');
  }
  await addMembership(pool, docA, hospital, 'doctor');
  await addMembership(pool, docB, hospital, 'doctor');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
  await addMembership(pool, clinicDoc, clinic, 'doctor');
  ids.general = await addDepartment(hospital, 'General Medicine');
  ids.surgery = await addDepartment(hospital, 'Surgery');
  ids.clinicDept = await addDepartment(clinic, 'Family Medicine');
  ids.a = await addDoctor(hospital, docA, ids.general);
  ids.b = await addDoctor(hospital, docB, ids.surgery);
  ids.c = await addDoctor(clinic, clinicDoc, ids.clinicDept);
  for (let n = 0; n < 6; n++) patients.push(await addPatient(hospital));
  clinicPatient = await addPatient(clinic);
});

/**
 * The counts read the database's clock, which a test cannot pin. A run that crosses midnight at
 * either hospital would compare two different days, so each test waits out the last seconds
 * before midnight in both timezones.
 */
beforeEach(async () => {
  for (;;) {
    const { rows } = await pool.query<{ near: boolean }>(
      `select bool_or(
         (now() at time zone z)::date <> ((now() + interval '30 seconds') at time zone z)::date
       ) as near
       from unnest(array['Asia/Kolkata', 'Asia/Dubai']) as z`,
    );
    if (!rows[0]?.near) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});

const tenants = () => [hospital.id, clinic.id, closed.id];

afterEach(async () => {
  await pool.query('delete from appointments where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from queue_tokens where tenant_id = any($1)', [tenants()]);
});

afterAll(async () => {
  await pool.query('delete from appointments where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from queue_tokens where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from doctors where tenant_id = any($1)', [tenants()]);
  await pool.query('delete from departments where tenant_id = any($1)', [tenants()]);
  await deleteUsers(pool, [desk, docA, docB, storeKeeper, clinicDoc]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('OPD capacity of today', () => {
  it('counts every slot of the day, those held and those still free, with the queue', async () => {
    const { day, minuteOf } = await todayAt('Asia/Kolkata');
    // Doctor A: one scheduled at 00:00, one completed at 00:15; a cancelled and a no-show free
    // theirs. Doctor B: one scheduled at 23:30.
    await appointment(hospital, ids.a, patients[0] ?? '', await minuteOf(0));
    await appointment(hospital, ids.a, patients[1] ?? '', await minuteOf(15), 'completed');
    await appointment(hospital, ids.a, patients[2] ?? '', await minuteOf(30), 'cancelled');
    await appointment(hospital, ids.a, patients[3] ?? '', await minuteOf(45), 'no_show');
    await appointment(hospital, ids.b, patients[4] ?? '', await minuteOf(1410));
    await token(hospital, day, ids.general, patients[0] ?? '');
    await token(hospital, day, ids.surgery, patients[1] ?? '');
    await token(hospital, day, ids.general, patients[2] ?? '', {
      doctorId: ids.a,
      status: 'called',
    });
    await token(hospital, day, ids.surgery, patients[3] ?? '', {
      doctorId: ids.b,
      status: 'served',
    });
    // Yesterday's tokens are not today's.
    const { rows } = await pool.query<{ day: string }>('select ($1::date - 1)::text as day', [day]);
    await token(hospital, rows[0]?.day ?? '', ids.general, patients[5] ?? '');

    const response = await get(hospital, desk);
    expect(response.statusCode).toBe(200);
    const body = response.json<Capacity>();
    expect(body).toEqual({
      day,
      slots: PER_DAY * 2,
      booked: 3,
      free: (await freeOf('Asia/Kolkata', [0, 15])) + (await freeOf('Asia/Kolkata', [1410])),
      waiting: 2,
      inConsult: 1,
    });
  });

  it('gives each hospital its own, and leaves out the queue where it is off', async () => {
    const { day, minuteOf } = await todayAt('Asia/Dubai');
    await appointment(clinic, ids.c, clinicPatient, await minuteOf(60));
    const body = (await get(clinic, desk)).json<Capacity>();
    expect(body).toEqual({
      day,
      slots: PER_DAY,
      booked: 1,
      free: await freeOf('Asia/Dubai', [60]),
    });
    // The clinic's appointment is not the hospital's.
    expect((await get(hospital, desk)).json<Capacity>().booked).toBe(0);
  });

  it('answers 0 slots on a day nobody works, not a full or empty percentage', async () => {
    await pool.query('delete from doctor_hours where tenant_id = $1', [clinic.id]);
    try {
      const body = (await get(clinic, desk)).json<Capacity>();
      expect(body).toMatchObject({ slots: 0, booked: 0, free: 0 });
    } finally {
      await pool.query(
        `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
         select $1, $2, day, $3, $4 from generate_series(1, 7) as day`,
        [clinic.id, ids.c, START, END],
      );
    }
  });

  it('applies the scope of appointment:read to the slots and the tokens', async () => {
    const { day, minuteOf } = await todayAt('Asia/Kolkata');
    await appointment(hospital, ids.a, patients[0] ?? '', await minuteOf(0));
    await appointment(hospital, ids.b, patients[1] ?? '', await minuteOf(0));
    // A's own and A's department's unassigned token count for A; B's do not.
    await token(hospital, day, ids.general, patients[0] ?? '');
    await token(hospital, day, ids.general, patients[2] ?? '', {
      doctorId: ids.a,
      status: 'called',
    });
    await token(hospital, day, ids.surgery, patients[1] ?? '');
    await token(hospital, day, ids.surgery, patients[3] ?? '', { doctorId: ids.b });
    const setScope = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and role_id = 'doctor'
           and permission in ('appointment:read', 'queue:read')`,
        [hospital.id, scope],
      );
    try {
      await setScope('own');
      expect((await get(hospital, docA)).json<Capacity>()).toMatchObject({
        slots: PER_DAY,
        booked: 1,
        waiting: 1,
        inConsult: 1,
      });
      await setScope('department');
      expect((await get(hospital, docB)).json<Capacity>()).toMatchObject({
        slots: PER_DAY,
        booked: 1,
        waiting: 2,
        inConsult: 0,
      });
    } finally {
      await setScope('all');
    }
    expect((await get(hospital, docA)).json<Capacity>()).toMatchObject({
      slots: PER_DAY * 2,
      waiting: 3,
    });
  });

  it('leaves out the queue figures for someone without queue:read', async () => {
    const revoke = () =>
      pool.query(
        "delete from role_permissions where tenant_id = $1 and role_id = 'receptionist' and permission = 'queue:read' returning scope",
        [hospital.id],
      );
    const { rows } = await revoke();
    try {
      const body = (await get(hospital, desk)).json<Capacity>();
      expect(body.slots).toBe(PER_DAY * 2);
      expect(body).not.toHaveProperty('waiting');
      expect(body).not.toHaveProperty('inConsult');
    } finally {
      for (const row of rows as { scope: string }[]) {
        await pool.query(
          "insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, 'receptionist', 'queue:read', $2)",
          [hospital.id, row.scope],
        );
      }
    }
  });

  it('adds no slots for an inactive doctor or one whose membership is inactive', async () => {
    const slotsOf = async () => (await get(hospital, desk)).json<Capacity>().slots;
    expect(await slotsOf()).toBe(PER_DAY * 2);
    await pool.query('update doctors set active = false where id = $1', [ids.b]);
    try {
      expect(await slotsOf()).toBe(PER_DAY);
    } finally {
      await pool.query('update doctors set active = true where id = $1', [ids.b]);
    }
    await pool.query(
      "update memberships set status = 'suspended' where tenant_id = $1 and user_id = $2",
      [hospital.id, docB.id],
    );
    try {
      expect(await slotsOf()).toBe(PER_DAY);
    } finally {
      await pool.query(
        "update memberships set status = 'active' where tenant_id = $1 and user_id = $2",
        [hospital.id, docB.id],
      );
    }
    expect(await slotsOf()).toBe(PER_DAY * 2);
  });

  it('does not count a skipped token as waiting', async () => {
    const { day } = await todayAt('Asia/Kolkata');
    await token(hospital, day, ids.general, patients[0] ?? '');
    await token(hospital, day, ids.general, patients[1] ?? '', { status: 'skipped' });
    expect((await get(hospital, desk)).json<Capacity>()).toMatchObject({
      waiting: 1,
      inConsult: 0,
    });
  });

  it('counts every slot an appointment longer than one slot overlaps as booked', async () => {
    const { minuteOf } = await todayAt('Asia/Kolkata');
    // 45 minutes from 00:00 hold the slots at 00:00, 00:15 and 00:30, and not the one at 00:45.
    await appointment(hospital, ids.a, patients[0] ?? '', await minuteOf(0), 'scheduled', 45);
    const body = (await get(hospital, desk)).json<Capacity>();
    expect(body.booked).toBe(3);
    expect(body.free).toBe(
      (await freeOf('Asia/Kolkata', [0, 15, 30])) + (await freeOf('Asia/Kolkata', [])),
    );
  });

  it('needs appointment:read and the module switched on', async () => {
    const refused = await get(hospital, storeKeeper);
    expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'permission_denied']);
    const off = await get(closed, desk);
    expect([off.statusCode, off.json().error.code]).toEqual([403, 'feature_disabled']);
  });

  it('writes nothing to the audit log: no patient is read', async () => {
    await get(hospital, desk);
    const { rows } = await pool.query(
      `select 1 from audit_log where tenant_id = $1 and actor_id = $2`,
      [hospital.id, desk.id],
    );
    expect(rows).toEqual([]);
  });
});
