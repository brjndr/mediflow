import { randomUUID } from 'node:crypto';
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

/** The hospital setting that makes a signed discharge summary a condition of discharge (#952). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let other: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let otherAdmin: TestUser;
const patients: string[] = [];
const otherPatients: string[] = [];

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const get = (url: string, { tenant = hospital, user = admin }: Options = {}) =>
  app.inject({ url, headers: as(tenant.id, user.id) });
const send = (
  method: 'POST' | 'PUT',
  url: string,
  body: object,
  { tenant = hospital, user = admin }: Options = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': randomUUID() },
    payload: body,
  });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Rule', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `RS-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

/** Admits a patient with nursing and pharmacy cleared, ready to be discharged. */
async function admit(options: Options = {}) {
  const ours = (options.tenant ?? hospital) === hospital ? patients : otherPatients;
  const response = await send(
    'POST',
    '/admissions',
    { patientId: ours.pop() ?? '', admissionType: 'planned' },
    options,
  );
  if (response.statusCode !== 201) throw new Error(response.body);
  const created = response.json<{ admission: { id: string; version: number } }>().admission;
  for (const kind of ['nursing', 'pharmacy']) {
    await send(
      'PUT',
      `/admissions/${created.id}/discharge-plan/clearances/${kind}`,
      { status: 'cleared' },
      options,
    );
  }
  return created;
}
const discharge = (
  stay: { id: string; version: number },
  type = 'against_advice',
  options?: Options,
) =>
  send(
    'POST',
    `/admissions/${stay.id}/discharge`,
    { dischargeType: type, version: stay.version },
    options,
  );
const setRequired = (on: boolean, options?: Options) =>
  send('PUT', '/admission-settings', { requireDischargeSummary: on }, options);
const sections = {
  diagnoses: 'Pneumonia',
  procedures: '',
  course: 'Recovered',
  results: '',
  medicines: '',
  followUp: '',
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const features = {
    admissions: true,
    clinical: true,
    patients: true,
    doctors: true,
    departments: true,
  };
  hospital = await createTenant(pool, 'Rule Hospital', { features });
  other = await createTenant(pool, 'Rule Clinic', { features });
  for (const tenant of [hospital, other]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Rule Admin', { withPassword: false });
  nurse = await createUser(pool, 'Rule Nurse', { withPassword: false });
  otherAdmin = await createUser(pool, 'Rule Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, otherAdmin, other, 'admin');
  for (const [tenant, user] of [
    [hospital, admin],
    [other, otherAdmin],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      'insert into departments (tenant_id, name) values ($1, $2) returning id',
      [tenant.id, 'Medicine'],
    );
    await pool.query(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General', 15)`,
      [tenant.id, user.id, rows[0]?.id],
    );
  }
  for (let n = 0; n < 6; n += 1) patients.push(await addPatient(hospital, `Pat${n}`));
  for (let n = 0; n < 2; n += 1) otherPatients.push(await addPatient(other, `Oth${n}`));
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'admission_settings',
      'discharge_summary_addenda',
      'discharge_summaries',
      'discharge_clearances',
      'discharge_plans',
      'clinical_notes',
      'admissions',
      'encounters',
      'outbox',
      'doctors',
      'departments',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, other.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, nurse, otherAdmin].filter(Boolean));
  await deleteTenants(pool, [hospital, other].filter(Boolean));
  await app.close();
});

describe('requiring a signed discharge summary', () => {
  it('is off until set, and a hospital that leaves it off discharges without a summary', async () => {
    expect((await get('/admission-settings')).json()).toEqual({ requireDischargeSummary: false });
    const stay = await admit();
    expect((await discharge(stay)).statusCode).toBe(200);
  });

  it('refuses a discharge until the summary is signed, a draft is not enough', async () => {
    expect((await setRequired(true)).json()).toEqual({ requireDischargeSummary: true });
    const stay = await admit();

    expect(errorOf(await discharge(stay))).toEqual([409, 'summary_unsigned']);
    await send('PUT', `/admissions/${stay.id}/discharge-summary`, sections);
    expect(errorOf(await discharge(stay))).toEqual([409, 'summary_unsigned']);
    // Nothing changed: the stay is still admitted.
    const still = await get(`/admissions/${stay.id}`);
    expect(still.json<{ admission: { status: string } }>().admission.status).toBe('admitted');

    await send('POST', `/admissions/${stay.id}/discharge-summary/sign`, { version: 1 });
    expect((await discharge(stay)).statusCode).toBe(200);
  });

  it('does not ask it of an absconded patient', async () => {
    const gone = await admit();
    expect((await discharge(gone, 'absconded')).statusCode).toBe(200);
  });

  it('keeps one hospital’s setting from another, and needs admission:configure', async () => {
    const stay = await admit({ tenant: other, user: otherAdmin });
    expect((await get('/admission-settings', { tenant: other, user: otherAdmin })).json()).toEqual({
      requireDischargeSummary: false,
    });
    const done = await discharge(stay, 'against_advice', { tenant: other, user: otherAdmin });
    expect(done.statusCode).toBe(200);

    expect((await get('/admission-settings', { user: nurse })).statusCode).toBe(403);
    expect((await setRequired(false, { user: nurse })).statusCode).toBe(403);
    expect((await setRequired(false)).json()).toEqual({ requireDischargeSummary: false });
  });
});
