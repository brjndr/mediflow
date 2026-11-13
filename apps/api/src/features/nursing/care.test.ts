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
 * Fluid balance and care plans (#160) through the real app and database: totals per window,
 * corrections, append-only tables, plan and task rules, the hospital boundary, permissions, the
 * module switch, the open stay, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let doctor: TestUser;
let nurse: TestUser;
let nurse2: TestUser;
let pharmacist: TestUser;
let clinicNurse: TestUser;
let closedNurse: TestUser;
let admission = '';
let dischargeAdmission = '';
let clinicAdmission = '';

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const headers = ({ tenant = hospital, user = nurse, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `care-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}, idempotent = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: idempotent ? (options.key ?? fresh()) : undefined }),
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

interface Fluid {
  id: string;
  direction: string;
  amountMl: number;
  correctsId?: string;
  correctedById?: string;
}
interface Totals {
  intakeMl: number;
  outputMl: number;
  balanceMl: number;
  entries: number;
}
interface Plan {
  id: string;
  status: string;
  tasks: { id: string; description: string; doneAt?: string; doneNote?: string }[];
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const fluid = (body: object, id = admission, o?: Options) =>
  post(`/admissions/${id}/fluids`, body, o);
const totals = (from: string, to: string, id = admission, o?: Options) =>
  get(
    `/admissions/${id}/fluids/totals?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    o,
  );
const plan = (body: object, id = admission, o?: Options) =>
  post(`/admissions/${id}/care-plans`, body, o);

const events = async (event: string) =>
  Number(
    (
      await pool.query<{ n: string }>(
        'select count(*) as n from outbox where tenant_id = $1 and event = $2',
        [hospital.id, event],
      )
    ).rows[0]?.n,
  );
const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);

async function one(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  return rows[0]?.id ?? '';
}
let mrn = 0;
const addPatient = (tenant: TestTenant, first: string) =>
  one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Care', '1975-05-01', 'male', '+91 9800000000', 'test') returning id`,
    [tenant.id, `NC-${String(++mrn).padStart(7, '0')}`, first],
  );

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'care_plan_tasks',
      'care_plans',
      'ward_fluids',
      'bed_assignments',
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
  const on = {
    features: {
      nursing: true,
      admissions: true,
      patients: true,
      doctors: true,
      departments: true,
    },
  };
  hospital = await createTenant(pool, 'Care Hospital', on);
  clinic = await createTenant(pool, 'Care Clinic', on);
  closed = await createTenant(pool, 'Care Closed', {
    features: { ...on.features, nursing: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  doctor = await createUser(pool, 'Care Doctor', { withPassword: false });
  nurse = await createUser(pool, 'Care Nurse', { withPassword: false });
  nurse2 = await createUser(pool, 'Care Nurse Two', { withPassword: false });
  pharmacist = await createUser(pool, 'Care Pharmacist', { withPassword: false });
  clinicNurse = await createUser(pool, 'Care Clinic Nurse', { withPassword: false });
  closedNurse = await createUser(pool, 'Care Closed Nurse', { withPassword: false });
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, nurse2, hospital, 'nurse');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicNurse, clinic, 'nurse');
  await addMembership(pool, closedNurse, closed, 'nurse');
  for (const tenant of [hospital, clinic]) {
    const dept = await one(
      'insert into departments (tenant_id, name) values ($1, $2) returning id',
      [tenant.id, 'Medicine'],
    );
    await pool.query(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General', 15)`,
      [tenant.id, doctor.id, dept],
    );
  }
  const admit = async (patientId: string, tenant = hospital) =>
    ok<{ admission: { id: string } }>(
      await post('/admissions', { patientId, admissionType: 'planned' }, { tenant, user: doctor }),
      201,
    );
  admission = (await admit(await addPatient(hospital, 'Asha'))).admission.id;
  dischargeAdmission = (await admit(await addPatient(hospital, 'Bina'))).admission.id;
  clinicAdmission = (await admit(await addPatient(clinic, 'Clinic'), clinic)).admission.id;
});

afterAll(async () => {
  try {
    await cleanup();
    for (const table of ['doctors', 'patients', 'departments']) {
      await pool.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await deleteUsers(
      pool,
      [doctor, nurse, nurse2, pharmacist, clinicNurse, closedNurse].filter(Boolean),
    );
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('fluid intake and output', () => {
  it('records entries and totals them for a window', async () => {
    const a = await ok<Fluid>(
      await fluid({ kind: 'oral', amountMl: 250, observedAt: hoursAgo(5) }),
      201,
    );
    expect(a).toMatchObject({ direction: 'intake', amountMl: 250 });
    await fluid({ kind: 'intravenous', amountMl: 500, observedAt: hoursAgo(4) });
    const urine = await ok<Fluid>(
      await fluid({ kind: 'urine', amountMl: 300, observedAt: hoursAgo(3) }),
      201,
    );
    expect(urine.direction).toBe('output');
    await fluid({ kind: 'oral', amountMl: 100, observedAt: hoursAgo(30) });
    const t = await ok<Totals>(await totals(hoursAgo(10), hoursAgo(0.5)));
    expect(t).toMatchObject({ intakeMl: 750, outputMl: 300, balanceMl: 450, entries: 3 });
    const none = await ok<Totals>(await totals(hoursAgo(2), hoursAgo(1)));
    expect(none).toMatchObject({ intakeMl: 0, outputMl: 0, balanceMl: 0, entries: 0 });
    expect(await audited('ward_fluid', urine.id)).toEqual(['create']);
    expect(await events('fluid.recorded')).toBeGreaterThanOrEqual(3);
  });

  it('lists a window newest first and pages', async () => {
    const first = await ok<Page<Fluid>>(
      await get(`/admissions/${admission}/fluids?limit=2&from=${encodeURIComponent(hoursAgo(10))}`),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await ok<Page<Fluid>>(
      await get(
        `/admissions/${admission}/fluids?limit=2&cursor=${first.nextCursor}&from=${encodeURIComponent(hoursAgo(10))}`,
      ),
    );
    expect(second.items).toHaveLength(1);
  });

  it('refuses a bad amount, the future and a long window', async () => {
    expect((await fluid({ kind: 'oral', amountMl: 0 })).statusCode).toBe(400);
    expect((await fluid({ kind: 'oral', amountMl: 5001 })).statusCode).toBe(400);
    expect((await fluid({ kind: 'water', amountMl: 10 })).statusCode).toBe(400);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(errorOf(await fluid({ kind: 'oral', amountMl: 10, observedAt: future }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect((await totals(hoursAgo(100), hoursAgo(0))).statusCode).toBe(400);
    expect((await totals(hoursAgo(1), hoursAgo(2))).statusCode).toBe(400);
  });

  it('corrects an entry once, keeping both and counting the correction', async () => {
    const entry = await ok<Fluid>(
      await fluid({ kind: 'oral', amountMl: 900, observedAt: hoursAgo(8) }),
      201,
    );
    const before = await ok<Totals>(await totals(hoursAgo(8.5), hoursAgo(7.5)));
    expect(before.intakeMl).toBe(900);
    const fix = await ok<Fluid>(
      await post(`/admissions/${admission}/fluids/${entry.id}/correct`, {
        kind: 'oral',
        amountMl: 90,
        reason: 'Typed a zero too many',
      }),
      201,
    );
    expect(fix.correctsId).toBe(entry.id);
    const after = await ok<Totals>(await totals(hoursAgo(8.5), hoursAgo(7.5)));
    expect(after).toMatchObject({ intakeMl: 90, entries: 1 });
    const again = await post(`/admissions/${admission}/fluids/${entry.id}/correct`, {
      kind: 'oral',
      amountMl: 80,
      reason: 'Again',
    });
    expect(errorOf(again)).toEqual([422, 'already_corrected']);
    const flipped = await ok<Fluid>(
      await fluid({ kind: 'oral', amountMl: 10, observedAt: hoursAgo(6) }),
      201,
    );
    expect(
      errorOf(
        await post(`/admissions/${admission}/fluids/${flipped.id}/correct`, {
          kind: 'urine',
          amountMl: 10,
          reason: 'Wrong side',
        }),
      ),
    ).toEqual([422, 'direction_changed']);
    expect(
      errorOf(
        await post(`/admissions/${admission}/fluids/00000000-0000-4000-8000-000000000000/correct`, {
          kind: 'oral',
          amountMl: 10,
          reason: 'None',
        }),
      ),
    ).toEqual([404, 'fluid_not_found']);
  });

  it('answers a repeated key with the same entry', async () => {
    const key = fresh();
    const a = await ok<Fluid>(await fluid({ kind: 'oral', amountMl: 15 }, admission, { key }), 201);
    const b = await ok<Fluid>(await fluid({ kind: 'oral', amountMl: 15 }, admission, { key }), 201);
    expect(b.id).toBe(a.id);
  });

  it('is append-only in the database, to the owner too', async () => {
    const entry = await ok<Fluid>(await fluid({ kind: 'oral', amountMl: 5 }), 201);
    await expect(
      pool.query('update ward_fluids set amount_ml = 6 where id = $1', [entry.id]),
    ).rejects.toThrow(/never changed/);
    await expect(pool.query('delete from ward_fluids where id = $1', [entry.id])).rejects.toThrow(
      /never changed/,
    );
    await expect(pool.query('truncate ward_fluids')).rejects.toThrow(/never emptied/);
  });

  it('keeps to the hospital, the permission and the module switch', async () => {
    expect(
      errorOf(await get(`/admissions/${admission}/fluids`, { tenant: clinic, user: clinicNurse })),
    ).toEqual([404, 'admission_not_found']);
    expect((await get(`/admissions/${clinicAdmission}/fluids`)).statusCode).toBe(404);
    expect((await get(`/admissions/${admission}/fluids`, { user: pharmacist })).statusCode).toBe(
      403,
    );
    // A doctor reads but does not record.
    expect((await get(`/admissions/${admission}/fluids`, { user: doctor })).statusCode).toBe(200);
    expect(
      (await fluid({ kind: 'oral', amountMl: 10 }, admission, { user: doctor })).statusCode,
    ).toBe(403);
    expect(
      (await get(`/admissions/${clinicAdmission}/fluids`, { tenant: closed, user: closedNurse }))
        .statusCode,
    ).toBe(403);
  });
});

describe('care plans', () => {
  it('starts a plan with tasks, completes a task and ends the plan', async () => {
    const made = await ok<Plan>(
      await plan({
        problem: 'Risk of falls',
        goal: 'No fall during the stay',
        tasks: [
          { description: 'Bed rails up' },
          { description: 'Hourly round', dueAt: hoursAgo(-1) },
        ],
      }),
      201,
    );
    expect(made.status).toBe('active');
    expect(made.tasks.map((task) => task.description)).toEqual(['Bed rails up', 'Hourly round']);
    expect(await audited('care_plan', made.id)).toEqual(['create']);
    expect(await events('careplan.created')).toBeGreaterThanOrEqual(1);

    const taskId = made.tasks[0]?.id ?? '';
    const done = await ok<Plan>(
      await post(`/care-plan-tasks/${taskId}/done`, { note: 'Done at 9' }, { user: nurse2 }, false),
    );
    expect(done.tasks[0]).toMatchObject({ doneNote: 'Done at 9' });
    expect(done.tasks[0]?.doneAt).toBeTruthy();
    expect(errorOf(await post(`/care-plan-tasks/${taskId}/done`, {}, {}, false))).toEqual([
      409,
      'already_done',
    ]);

    const added = await ok<Plan>(
      await post(`/care-plans/${made.id}/tasks`, { description: 'Check footwear' }),
      201,
    );
    expect(added.tasks).toHaveLength(3);

    const listed = await ok<Page<Plan>>(await get(`/admissions/${admission}/care-plans`));
    expect(listed.items.find((item) => item.id === made.id)?.tasks).toHaveLength(3);

    const closedPlan = await ok<Plan>(
      await post(`/care-plans/${made.id}/close`, { status: 'completed' }, {}, false),
    );
    expect(closedPlan.status).toBe('completed');
    expect(
      errorOf(await post(`/care-plans/${made.id}/close`, { status: 'cancelled' }, {}, false)),
    ).toEqual([409, 'plan_closed']);
    expect(errorOf(await post(`/care-plans/${made.id}/tasks`, { description: 'Late' }))).toEqual([
      409,
      'plan_closed',
    ]);
    const secondTask = added.tasks[1]?.id ?? '';
    expect(errorOf(await post(`/care-plan-tasks/${secondTask}/done`, {}, {}, false))).toEqual([
      409,
      'plan_closed',
    ]);
    expect(await events('careplan.task_done')).toBeGreaterThanOrEqual(1);
    expect(await events('careplan.closed')).toBeGreaterThanOrEqual(1);
  });

  it('refuses empty text and answers a repeated key with the same plan', async () => {
    expect((await plan({ problem: '' })).statusCode).toBe(400);
    expect((await plan({ problem: '  ' })).statusCode).toBe(400);
    expect((await plan({ problem: 'x', tasks: [{ description: ' ' }] })).statusCode).toBe(400);
    const key = fresh();
    const a = await ok<Plan>(
      await plan({ problem: 'Pressure area care' }, admission, { key }),
      201,
    );
    const b = await ok<Plan>(
      await plan({ problem: 'Pressure area care' }, admission, { key }),
      201,
    );
    expect(b.id).toBe(a.id);
  });

  it('stays within the hospital and the permissions', async () => {
    const made = await ok<Plan>(
      await plan({ problem: 'Pain', tasks: [{ description: 'Score' }] }),
      201,
    );
    const other = { tenant: clinic, user: clinicNurse };
    expect(
      errorOf(await post(`/care-plans/${made.id}/close`, { status: 'completed' }, other, false)),
    ).toEqual([404, 'plan_not_found']);
    expect(
      errorOf(await post(`/care-plan-tasks/${made.tasks[0]?.id}/done`, {}, other, false)),
    ).toEqual([404, 'task_not_found']);
    expect((await get(`/admissions/${admission}/care-plans`, other)).statusCode).toBe(404);
    expect((await plan({ problem: 'x' }, admission, { user: doctor })).statusCode).toBe(403);
    expect((await get(`/admissions/${admission}/care-plans`, { user: doctor })).statusCode).toBe(
      200,
    );
    expect(
      (await get(`/admissions/${admission}/care-plans`, { user: pharmacist })).statusCode,
    ).toBe(403);
    expect(
      (await plan({ problem: 'x' }, clinicAdmission, { tenant: closed, user: closedNurse }))
        .statusCode,
    ).toBe(403);
  });

  it('never changes or removes a plan except its status, and a task except its doing', async () => {
    const made = await ok<Plan>(
      await plan({ problem: 'Diet', tasks: [{ description: 'Log meals' }] }),
      201,
    );
    await expect(
      pool.query('update care_plans set problem = $2 where id = $1', [made.id, 'Other']),
    ).rejects.toThrow(/Only the status/);
    await expect(
      pool.query('update care_plan_tasks set description = $2 where id = $1', [
        made.tasks[0]?.id,
        'Other',
      ]),
    ).rejects.toThrow(/Only the doing/);
    await expect(pool.query('delete from care_plans where id = $1', [made.id])).rejects.toThrow(
      /never changed/,
    );
    await expect(pool.query('truncate care_plan_tasks')).rejects.toThrow(/never emptied/);
  });
});

describe('a stay that has ended', () => {
  it('keeps what was recorded and takes nothing new', async () => {
    const made = await ok<Plan>(
      await plan({ problem: 'Wound', tasks: [{ description: 'Dress' }] }, dischargeAdmission),
      201,
    );
    await fluid({ kind: 'oral', amountMl: 100 }, dischargeAdmission);
    const stay = await ok<{ admission: { version: number } }>(
      await get(`/admissions/${dischargeAdmission}`, { user: doctor }),
    );
    await ok(
      await post(
        `/admissions/${dischargeAdmission}/discharge`,
        { dischargeType: 'absconded', version: stay.admission.version },
        { user: doctor },
      ),
    );
    expect(errorOf(await fluid({ kind: 'oral', amountMl: 100 }, dischargeAdmission))).toEqual([
      409,
      'admission_not_open',
    ]);
    expect(errorOf(await plan({ problem: 'New' }, dischargeAdmission))).toEqual([
      409,
      'admission_not_open',
    ]);
    expect(
      errorOf(await post(`/care-plan-tasks/${made.tasks[0]?.id}/done`, {}, {}, false)),
    ).toEqual([409, 'admission_not_open']);
    expect((await get(`/admissions/${dischargeAdmission}/fluids`)).statusCode).toBe(200);
    expect((await get(`/admissions/${dischargeAdmission}/care-plans`)).statusCode).toBe(200);
  });
});
