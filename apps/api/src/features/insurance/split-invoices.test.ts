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
  hospitalDay,
  grantRoleDefaults,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/**
 * Billing the payer share of an insured visit as its own invoice (#977), through the real app
 * and database.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let clinicAdmin: TestUser;
let serviceA: string;
let serviceB: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `clm-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object | undefined, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    ...(body ? { payload: body } : {}),
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

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'claim_events',
  'claims',
  'claim_counters',
  'coverage_splits',
  'pre_auths',
  'patient_policies',
  'rate_agreement_rates',
  'rate_agreements',
  'payer_plan_services',
  'payer_plans',
  'payers',
];
async function wipeAll(extra: string[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [...TABLES, ...extra]) {
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

const allOn = { insurance: true, patients: true, billing: true };

const one = async (sql: string, params: unknown[]) =>
  ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

let mrn = 0;
/** A new patient with a visit and charges `[service, price]`. */
async function visit(charges: [string, number][], tenant: TestTenant = hospital) {
  const patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Clm', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CL-${String(++mrn).padStart(7, '0')}`],
  );
  const encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [tenant.id, patientId, admin.id],
  );
  for (const [service, price] of charges) await charge(encounterId, patientId, service, price);
  return { patientId, encounterId };
}
async function charge(encounterId: string, patientId: string, service: string, price: number) {
  await pool.query(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor)
     values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, $6)`,
    [hospital.id, encounterId, patientId, service, `clm-test:${++keys}`, price],
  );
}

let codes = 0;
const dayFrom = hospitalDay;

/** A payer with a plan and a policy on the patient; returns the payer id. */
async function cover(patientId: string, plan: object = {}, agreement?: object) {
  const org = await ok<{ id: string }>(
    await post('/payers', { kind: 'insurer', code: `CP${++codes}`, name: `Claim Payer ${codes}` }),
    201,
  );
  const made = await ok<{ id: string }>(
    await post(`/payers/${org.id}/plans`, {
      code: `CPL${++codes}`,
      name: `Claim Plan ${codes}`,
      coverageMode: 'all_except',
      copayPercent: 10,
      preAuthRequired: false,
      services: [],
      ...plan,
    }),
    201,
  );
  if (agreement) {
    await ok(
      await post(`/payers/${org.id}/rate-agreements`, {
        name: 'Agreed rates',
        effectiveFrom: dayFrom(0),
        discountBp: 0,
        rates: [],
        ...agreement,
      }),
      201,
    );
  }
  await ok(
    await post(`/patients/${patientId}/policies`, {
      planId: made.id,
      policyNumber: `POL-${++codes}`,
      holderName: 'Holder Name',
      relationship: 'self',
      validFrom: dayFrom(-30),
    }),
    201,
  );
  return org.id;
}

interface SplitBody {
  splitGroup: string;
  payerInvoiceId: string;
  patientInvoiceId?: string;
  payerMinor: number;
  patientMinor: number;
}
interface InvoiceBody {
  id: string;
  status: string;
  number?: string;
  totalMinor: number;
  payerId?: string;
  payerName?: string;
  splitGroup?: string;
  version: number;
  lines: { chargeId?: string; description: string; totalMinor: number }[];
}
const split = (encounterId: string, options: Options = {}) =>
  post(`/encounters/${encounterId}/split-invoices`, undefined, options);
const invoiceOf = async (id: string, options: Options = {}) =>
  ok<InvoiceBody>(await get(`/invoices/${id}`, options));

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Split Hospital', { features: allOn });
  clinic = await createTenant(pool, 'Split Clinic', { features: allOn });
  closed = await createTenant(pool, 'Split Closed', {
    features: { insurance: true, patients: true },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Split Admin', { withPassword: false });
  nurse = await createUser(pool, 'Split Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Split Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const service = (code: string, name: string) =>
    one(
      `insert into services (tenant_id, code, name, category, tax_class) values ($1, $2, $3, 'procedure', 'exempt') returning id`,
      [hospital.id, code, name],
    );
  serviceA = await service('SPL-A', 'Split Service A');
  serviceB = await service('SPL-B', 'Split Service B');
}, 60_000);

afterAll(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      for (const table of ['invoice_lines', 'invoices', 'invoice_counters']) {
        await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
      }
      await client.query('commit');
    } finally {
      client.release();
    }
    await wipeAll();
    await pool.query('delete from charges where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from encounters where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from services where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(pool, [admin, nurse, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('the payer share as its own invoice', () => {
  it('makes a draft for each share that adds up to the ledger, issues both, and bills each charge once', async () => {
    const { patientId, encounterId } = await visit([
      [serviceA, 10_000],
      [serviceB, 3_333],
    ]);
    const payerId = await cover(patientId, { copayPercent: 20 });
    const body = await ok<SplitBody>(await split(encounterId), 201);
    expect(body.payerMinor + body.patientMinor).toBe(13_333);
    expect(body.payerMinor).toBe(8_000 + 2_666);
    expect(body.patientInvoiceId).toBeDefined();

    const payerInvoice = await invoiceOf(body.payerInvoiceId);
    const patientInvoice = await invoiceOf(body.patientInvoiceId as string);
    expect(payerInvoice).toMatchObject({
      status: 'draft',
      payerId,
      splitGroup: body.splitGroup,
      totalMinor: body.payerMinor,
    });
    expect(payerInvoice.payerName).toContain('Claim Payer');
    expect(patientInvoice.payerId).toBeUndefined();
    expect(patientInvoice.totalMinor).toBe(body.patientMinor);
    expect(payerInvoice.lines).toHaveLength(2);
    expect(payerInvoice.lines[0]?.description).toMatch(/\(payer share\)$/);
    expect(patientInvoice.lines[0]?.description).toMatch(/\(patient share\)$/);

    for (const invoice of [patientInvoice, payerInvoice]) {
      const issued = await ok<InvoiceBody>(
        await post(`/invoices/${invoice.id}/issue`, { version: invoice.version }),
      );
      expect(issued.status).toBe('issued');
      expect(issued.number).toBeDefined();
    }
    const states = await pool.query<{ status: string; invoice_id: string }>(
      'select status, invoice_id from charges where encounter_id = $1',
      [encounterId],
    );
    expect(states.rows.every((row) => row.status === 'invoiced')).toBe(true);
    expect(states.rows.every((row) => row.invoice_id === patientInvoice.id)).toBe(true);
    expect(await audited('invoice', body.payerInvoiceId)).toEqual([
      'create',
      'read',
      'update',
      'read',
    ]);
  });

  it('makes only the payer invoice when the patient owes nothing, and it holds the charges', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 5_000]]);
    await cover(patientId, { copayPercent: 0 });
    const body = await ok<SplitBody>(await split(encounterId), 201);
    expect(body.patientInvoiceId).toBeUndefined();
    expect(body.patientMinor).toBe(0);
    expect(body.payerMinor).toBe(5_000);
    const held = await pool.query<{ invoice_id: string }>(
      'select invoice_id from charges where encounter_id = $1',
      [encounterId],
    );
    expect(held.rows[0]?.invoice_id).toBe(body.payerInvoiceId);
    const invoice = await invoiceOf(body.payerInvoiceId);
    await ok(await post(`/invoices/${invoice.id}/issue`, { version: invoice.version }));
  });

  it('answers a repeat of one key with the same invoices', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 1_000]]);
    await cover(patientId);
    const key = fresh();
    const first = await ok<SplitBody>(await split(encounterId, { key }), 201);
    const again = await ok<SplitBody>(await split(encounterId, { key }), 201);
    expect(again).toEqual(first);
    const count = await pool.query('select 1 from invoices where encounter_id = $1', [encounterId]);
    expect(count.rowCount).toBe(2);
  });

  it('refuses a second split, nothing for the payer, no policy and a visit that does not exist', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 1_000]]);
    expect(errorOf(await split(encounterId))).toEqual([404, 'no_active_policy']);
    await cover(patientId);
    await ok(await split(encounterId), 201);
    expect(errorOf(await split(encounterId))).toEqual([409, 'charges_not_pending']);

    const none = await visit([[serviceA, 1_000]]);
    await cover(none.patientId, { coverageMode: 'only_listed', services: [] });
    expect(errorOf(await split(none.encounterId))).toEqual([422, 'nothing_to_bill']);

    expect(errorOf(await split('00000000-0000-4000-8000-000000000000'))).toEqual([
      404,
      'encounter_not_found',
    ]);
  });

  it('leaves a split draft as it is made, and a cancelled visit unbilled', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 2_000]]);
    await cover(patientId);
    const body = await ok<SplitBody>(await split(encounterId), 201);
    const invoice = await invoiceOf(body.payerInvoiceId);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/invoices/${invoice.id}`,
      headers: headers(),
      payload: { chargeIds: [], manualLines: [], version: invoice.version },
    });
    expect(errorOf(edit)).toEqual([409, 'split_invoice_locked']);

    const gone = await visit([[serviceA, 2_000]]);
    await cover(gone.patientId);
    await pool.query(
      "update encounters set status = 'cancelled', cancel_reason = 'test', ended_at = now(), ended_by = $2 where id = $1",
      [gone.encounterId, admin.id],
    );
    expect(errorOf(await split(gone.encounterId))).toEqual([409, 'encounter_cancelled']);
  });

  it('is for the billing desk of the hospital that owns the visit, with billing switched on', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 1_000]]);
    await cover(patientId);
    expect((await split(encounterId, { user: nurse })).statusCode).toBe(403);
    expect(errorOf(await split(encounterId, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'encounter_not_found',
    ]);
    expect(errorOf(await split(encounterId, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    const none = await pool.query('select 1 from invoices where encounter_id = $1', [encounterId]);
    expect(none.rowCount).toBe(0);
  });

  it('is refused by the database when an invoice moves to another group or payer', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 1_000]]);
    await cover(patientId);
    const body = await ok<SplitBody>(await split(encounterId), 201);
    await expect(
      pool.query('update invoices set split_group = gen_random_uuid() where id = $1', [
        body.payerInvoiceId,
      ]),
    ).rejects.toThrow(/keeps its split/);
  });
});
