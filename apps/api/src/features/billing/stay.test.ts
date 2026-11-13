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
import { postBedDays, postBedDaysEverywhere } from './bed-days.js';

/**
 * Discharge and inpatient billing (#169): the running bill, deposits and the settlement of a
 * stay, the discharge policy, the idempotent bed-day charges, the discharge plan with its
 * clearances and the signed discharge summary; through the real app and database, with the
 * hospital boundary and permissions.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let nurse: TestUser;
let clinicAdmin: TestUser;
let department: string;
let bedIds: string[] = [];
let serviceId: string;
let patientIds: string[] = [];
let clinicPatient: string;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
const get = (url: string, { tenant = hospital, user = admin }: Options = {}) =>
  app.inject({ url, headers: as(tenant.id, user.id) });
const send = (
  method: 'POST' | 'PUT',
  url: string,
  body: object | undefined,
  { tenant = hospital, user = admin, key = randomUUID() }: Options = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    ...(body === undefined ? {} : { payload: body }),
  });
const post = (url: string, body: object | undefined, options?: Options) =>
  send('POST', url, body, options);
const put = (url: string, body: object, options?: Options) => send('PUT', url, body, options);
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function ok<T>(response: Response, status = 200): Promise<T> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<T>();
}

interface Bill {
  lines: { source: string; count: number; totalMinor: number; accruing?: boolean }[];
  chargesMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  depositsMinor: number;
  balanceMinor: number;
  estimateMinor?: number;
  estimateNote?: string;
  patientName: string;
}
interface Settlement {
  chargesMinor: number;
  unbilledMinor: number;
  invoicedMinor: number;
  paidMinor: number;
  dueMinor: number;
  depositsMinor: number;
  depositsAppliedMinor: number;
  depositsRefundedMinor: number;
  depositsHeldMinor: number;
  excessDepositMinor: number;
  invoices: { id: string; status: string }[];
  policy: string;
  clearance: { cleared: boolean; reasons: string[] };
}
interface Admission {
  admission: { id: string; encounterId: string; version: number };
}
interface Plan {
  advice?: string;
  version: number;
  clearances: { kind: string; status: string; note?: string; clearedByName?: string }[];
}
interface Summary {
  status: string;
  version: number;
  signedByName?: string;
  addenda: { body: string }[];
  diagnoses: string;
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Stay', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `ST-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

let sourceCount = 0;
async function addCharge(encounterId: string, patientId: string, price: number) {
  sourceCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into charges (tenant_id, encounter_id, patient_id, source, source_ref, description,
       quantity, unit_price_minor)
     values ($1, $2, $3, 'service', $4, 'Stay charge', 1, $5) returning id`,
    [hospital.id, encounterId, patientId, `stay-test:${sourceCount}`, price],
  );
  return rows[0]?.id ?? '';
}

let next = 0;
async function admit(
  withBed = false,
): Promise<{ id: string; encounterId: string; patientId: string }> {
  const patientId = patientIds[next] ?? '';
  const bedId = bedIds[next] ?? '';
  next += 1;
  const created = await ok<Admission>(
    await post('/admissions', {
      patientId,
      admissionType: 'planned',
      ...(withBed ? { bedId } : {}),
    }),
    201,
  );
  return { id: created.admission.id, encounterId: created.admission.encounterId, patientId };
}

async function issueInvoice(stay: { encounterId: string }, chargeIds: string[]) {
  const draft = await ok<{ id: string; version: number }>(
    await post(`/encounters/${stay.encounterId}/invoices`, { chargeIds, manualLines: [] }),
    201,
  );
  return ok<{ id: string; totalMinor: number }>(
    await post(`/invoices/${draft.id}/issue`, { version: draft.version }),
  );
}

const openRegister = async () => {
  await post('/cash-registers/sessions', { openingMinor: 1_000 });
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const features = {
    admissions: true,
    wards: true,
    clinical: true,
    patients: true,
    doctors: true,
    departments: true,
    services: true,
    billing: true,
  };
  hospital = await createTenant(pool, 'Stay Hospital', { features });
  clinic = await createTenant(pool, 'Stay Clinic', { features });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Stay Admin', { withPassword: false });
  nurse = await createUser(pool, 'Stay Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Stay Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
  department = await one('insert into departments (tenant_id, name) values ($1, $2) returning id', [
    hospital.id,
    'Medicine',
  ]);
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15)`,
    [hospital.id, admin.id, department],
  );
  serviceId = await one(
    `insert into services (tenant_id, code, name, category, tax_class)
     values ($1, 'BED1', 'General bed day', 'bed', 'exempt') returning id`,
    [hospital.id],
  );
  await pool.query(
    `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
     select $1, $2, id, 2500, current_date - 30 from price_lists where tenant_id = $1 and standard`,
    [hospital.id, serviceId],
  );
  const category = await one(
    'insert into bed_categories (tenant_id, name, service_id) values ($1, $2, $3) returning id',
    [hospital.id, 'General', serviceId],
  );
  const ward = await one(
    'insert into wards (tenant_id, code, name, department_id) values ($1, $2, $3, $4) returning id',
    [hospital.id, 'W1', 'Ward One', department],
  );
  const room = await one(
    'insert into rooms (tenant_id, ward_id, name) values ($1, $2, $3) returning id',
    [hospital.id, ward, 'Room 1'],
  );
  bedIds = [];
  for (let n = 1; n <= 24; n += 1) {
    bedIds.push(
      await one(
        'insert into beds (tenant_id, ward_id, room_id, number, bed_category_id) values ($1, $2, $3, $4, $5) returning id',
        [hospital.id, ward, room, `B${n}`, category],
      ),
    );
  }
  patientIds = [];
  for (let n = 0; n < 24; n += 1) patientIds.push(await addPatient(hospital, `Pat${n}`));
  clinicPatient = await addPatient(clinic, 'Clinic');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'deposit_refunds',
      'deposit_applications',
      'deposits',
      'discharge_summary_addenda',
      'discharge_summaries',
      'discharge_clearances',
      'discharge_plans',
      'stay_bill_estimates',
      'billing_settings',
      'payments',
      'cash_register_sessions',
      'invoice_lines',
      'charges',
      'invoices',
      'invoice_counters',
      'bed_assignments',
      'clinical_notes',
      'admissions',
      'encounters',
      'outbox',
      'beds',
      'rooms',
      'wards',
      'bed_categories',
      'service_prices',
      'services',
      'doctors',
      'patients',
      'departments',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, nurse, clinicAdmin].filter(Boolean));
  await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  await app.close();
});

describe('the running bill', () => {
  it('adds the ledger up by source, shows the estimate and counts deposits once', async () => {
    const stay = await admit();
    await addCharge(stay.encounterId, stay.patientId, 10_000);
    await addCharge(stay.encounterId, stay.patientId, 5_000);
    await openRegister();
    await ok(
      await post(`/admissions/${stay.id}/deposits`, { amountMinor: 4_000, method: 'cash' }),
      201,
    );

    const bill = await ok<Bill>(await get(`/admissions/${stay.id}/bill`));
    expect(bill.lines).toEqual([{ source: 'service', count: 2, totalMinor: 15_000 }]);
    expect(bill).toMatchObject({
      chargesMinor: 15_000,
      depositsMinor: 4_000,
      paidMinor: 0,
      balanceMinor: 11_000,
      patientName: 'Pat0 Stay',
    });

    const estimated = await ok<Bill>(
      await put(`/admissions/${stay.id}/bill-estimate`, { amountMinor: 20_000, note: 'Package' }),
    );
    expect(estimated).toMatchObject({ estimateMinor: 20_000, estimateNote: 'Package' });
  });

  it('is audited and needs charge:read, and stays inside the hospital', async () => {
    const stay = await admit();
    await get(`/admissions/${stay.id}/bill`);
    const { rows } = await pool.query(
      `select 1 from audit_log where tenant_id = $1 and entity = 'running_bill' and entity_id = $2`,
      [hospital.id, stay.id],
    );
    expect(rows.length).toBe(1);
    expect(errorOf(await get(`/admissions/${stay.id}/bill`, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(await get(`/admissions/${stay.id}/bill`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'admission_not_found']);
    expect(
      errorOf(
        await get(`/admissions/${stay.id}/settlement`, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'admission_not_found']);
    expect(
      errorOf(
        await post(
          `/admissions/${stay.id}/deposits`,
          { amountMinor: 1, method: 'card' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'admission_not_found']);
    void clinicPatient;
  });
});

describe('deposits and the settlement', () => {
  it('takes a deposit once per key, lists it, and refuses a closed stay', async () => {
    const stay = await admit();
    const key = randomUUID();
    const body = { amountMinor: 3_000, method: 'upi', reference: 'UPI-1' };
    const first = await ok<{ id: string; recordedByName: string }>(
      await post(`/admissions/${stay.id}/deposits`, body, { key }),
      201,
    );
    const again = await ok<{ id: string }>(
      await post(`/admissions/${stay.id}/deposits`, body, { key }),
      201,
    );
    expect(again.id).toBe(first.id);
    expect(first.recordedByName).toBe('Stay Admin');
    const list = await ok<{ items: { amountMinor: number }[] }>(
      await get(`/admissions/${stay.id}/deposits`),
    );
    expect(list.items).toHaveLength(1);
    expect(
      errorOf(await post(`/admissions/${stay.id}/deposits`, { amountMinor: 0, method: 'upi' })),
    ).toEqual([400, 'validation_failed']);

    await ok(
      await post(`/admissions/${stay.id}/discharge`, {
        dischargeType: 'absconded',
        version: 1,
      }),
    );
    expect(
      errorOf(await post(`/admissions/${stay.id}/deposits`, { amountMinor: 5, method: 'upi' })),
    ).toEqual([409, 'stay_closed']);
  });

  it('sets the deposit against an invoice and pays the excess back', async () => {
    const stay = await admit();
    await openRegister();
    const charge = await addCharge(stay.encounterId, stay.patientId, 6_000);
    await ok(
      await post(`/admissions/${stay.id}/deposits`, { amountMinor: 10_000, method: 'cash' }),
      201,
    );

    let settlement = await ok<Settlement>(await get(`/admissions/${stay.id}/settlement`));
    expect(settlement.clearance).toEqual({ cleared: false, reasons: ['unbilled'] });
    expect(settlement).toMatchObject({ unbilledMinor: 6_000, excessDepositMinor: 0 });

    const invoice = await issueInvoice(stay, [charge]);
    settlement = await ok<Settlement>(await get(`/admissions/${stay.id}/settlement`));
    expect(settlement).toMatchObject({
      unbilledMinor: 0,
      dueMinor: 6_000,
      depositsHeldMinor: 10_000,
      excessDepositMinor: 4_000,
    });
    expect(settlement.clearance.reasons).toEqual(['balance_due', 'excess_deposit']);

    const key = randomUUID();
    const applied = await ok<Settlement>(
      await post(`/admissions/${stay.id}/deposits/apply`, { invoiceId: invoice.id }, { key }),
    );
    expect(applied).toMatchObject({
      dueMinor: 0,
      paidMinor: 6_000,
      depositsAppliedMinor: 6_000,
      depositsHeldMinor: 4_000,
      excessDepositMinor: 4_000,
    });
    // A repeat applies nothing more.
    await ok(
      await post(`/admissions/${stay.id}/deposits/apply`, { invoiceId: invoice.id }, { key }),
    );
    expect(
      (await ok<Settlement>(await get(`/admissions/${stay.id}/settlement`))).depositsAppliedMinor,
    ).toBe(6_000);
    const paid = await pool.query(
      `select status, paid_minor::int as paid from invoices where id = $1`,
      [invoice.id],
    );
    expect(paid.rows[0]).toEqual({ status: 'paid', paid: 6_000 });
    expect(
      errorOf(await post(`/admissions/${stay.id}/deposits/apply`, { invoiceId: invoice.id })),
    ).toEqual([409, 'invoice_not_payable']);

    const bill = await ok<Bill>(await get(`/admissions/${stay.id}/bill`));
    expect(bill).toMatchObject({ depositsMinor: 10_000, paidMinor: 0, balanceMinor: -4_000 });

    expect(
      errorOf(
        await post(`/admissions/${stay.id}/deposits/refund`, {
          amountMinor: 4_001,
          method: 'upi',
          reason: 'Balance returned',
        }),
      ),
    ).toEqual([409, 'refund_exceeds']);
    const refunded = await ok<Settlement>(
      await post(`/admissions/${stay.id}/deposits/refund`, {
        amountMinor: 4_000,
        method: 'cash',
        reason: 'Balance returned',
      }),
    );
    expect(refunded).toMatchObject({
      depositsRefundedMinor: 4_000,
      depositsHeldMinor: 0,
      excessDepositMinor: 0,
    });
    expect(refunded.clearance).toEqual({ cleared: true, reasons: [] });

    // Cash taken and paid back both went through the drawer.
    const sessions = await ok<{
      items: {
        expectedMinor: number;
        totals: { method: string; paidMinor: number; refundedMinor: number }[];
      }[];
    }>(await get('/cash-registers/sessions'));
    const cash = sessions.items[0]?.totals.find((total) => total.method === 'cash');
    expect(cash?.paidMinor).toBeGreaterThanOrEqual(10_000);
    expect(cash?.refundedMinor).toBeGreaterThanOrEqual(4_000);
  });

  it('refuses apply with nothing held and a refund without permission', async () => {
    const stay = await admit();
    const charge = await addCharge(stay.encounterId, stay.patientId, 100);
    const invoice = await issueInvoice(stay, [charge]);
    expect(
      errorOf(await post(`/admissions/${stay.id}/deposits/apply`, { invoiceId: invoice.id })),
    ).toEqual([409, 'no_deposit_held']);
    expect(
      errorOf(
        await post(
          `/admissions/${stay.id}/deposits/refund`,
          { amountMinor: 1, method: 'upi', reason: 'x' },
          { user: nurse },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });
});

describe('the discharge policy', () => {
  it('is warn until set, and changes with an audit entry', async () => {
    expect(await ok<{ mode: string }>(await get('/billing/discharge-policy'))).toEqual({
      mode: 'warn',
    });
    expect(
      await ok<{ mode: string }>(await put('/billing/discharge-policy', { mode: 'block' })),
    ).toEqual({
      mode: 'block',
    });
    const stay = await admit();
    expect((await ok<Settlement>(await get(`/admissions/${stay.id}/settlement`))).policy).toBe(
      'block',
    );
    expect(errorOf(await put('/billing/discharge-policy', { mode: 'sometimes' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(
      errorOf(await put('/billing/discharge-policy', { mode: 'off' }, { user: nurse })),
    ).toEqual([403, 'permission_denied']);
    await ok(await put('/billing/discharge-policy', { mode: 'warn' }));
    // The other hospital keeps its own.
    expect(
      await ok<{ mode: string }>(
        await get('/billing/discharge-policy', { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual({ mode: 'warn' });
  });
});

describe('bed days', () => {
  it('posts one charge per day and runs again without posting twice', async () => {
    const stay = await admit(true);
    // The patient has been in the bed for three days already.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update bed_assignments set assigned_at = now() - interval '3 days' where admission_id = $1`,
        [stay.id],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    // Until the job runs the days accrue on the running bill.
    const before = await ok<Bill>(await get(`/admissions/${stay.id}/bill`));
    expect(before.lines).toEqual([{ source: 'bed', count: 4, totalMinor: 10_000, accruing: true }]);

    expect(await postBedDays(pool, hospital.id)).toBeGreaterThanOrEqual(4);
    expect(await postBedDays(pool, hospital.id)).toBe(0);
    await postBedDaysEverywhere(pool);
    const { rows } = await pool.query(
      `select source_ref, unit_price_minor::int as price from charges
       where encounter_id = $1 and source = 'bed' order by source_ref`,
      [stay.encounterId],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.price === 2_500)).toBe(true);
    expect(new Set(rows.map((row) => row.source_ref)).size).toBe(4);

    const after = await ok<Bill>(await get(`/admissions/${stay.id}/bill`));
    expect(after.lines).toEqual([{ source: 'bed', count: 4, totalMinor: 10_000 }]);
    expect(after.chargesMinor).toBe(10_000);
  });

  it('does not charge the day a patient leaves a bed they were in the night before', async () => {
    const stay = await admit(true);
    await ok(
      await post(`/admissions/${stay.id}/discharge`, { dischargeType: 'absconded', version: 1 }),
    );
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update bed_assignments set assigned_at = now() - interval '2 days' where admission_id = $1`,
        [stay.id],
      );
      await client.query('commit');
    } finally {
      client.release();
    }
    await postBedDays(pool, hospital.id);
    const { rows } = await pool.query(
      `select count(*)::int as n from charges where encounter_id = $1 and source = 'bed'`,
      [stay.encounterId],
    );
    expect(rows[0]?.n).toBe(2);
  });
});

describe('the discharge plan and clearances', () => {
  it('holds a discharge until the clearances its type needs are done', async () => {
    const stay = await admit();
    const empty = await ok<Plan>(await get(`/admissions/${stay.id}/discharge-plan`));
    expect(empty.clearances.map((each) => each.status)).toEqual(['pending', 'pending', 'pending']);
    expect(empty.version).toBe(1);

    const advised = await ok<Plan>(
      await put(`/admissions/${stay.id}/discharge-plan`, { advice: 'Rest and fluids' }),
    );
    expect(advised).toMatchObject({ advice: 'Rest and fluids', version: 2 });

    expect(
      errorOf(
        await post(`/admissions/${stay.id}/discharge`, { dischargeType: 'routine', version: 1 }),
      ),
    ).toEqual([409, 'clearance_pending']);

    for (const kind of ['nursing', 'pharmacy']) {
      await ok(
        await put(`/admissions/${stay.id}/discharge-plan/clearances/${kind}`, {
          status: 'cleared',
          note: 'Done',
        }),
      );
    }
    // Against advice needs nursing and pharmacy only.
    const plan = await ok<Plan>(await get(`/admissions/${stay.id}/discharge-plan`));
    expect(plan.clearances[0]).toMatchObject({
      kind: 'nursing',
      status: 'cleared',
      note: 'Done',
      clearedByName: 'Stay Admin',
    });
    expect(
      errorOf(
        await post(`/admissions/${stay.id}/discharge`, { dischargeType: 'routine', version: 1 }),
      ),
    ).toEqual([409, 'clearance_pending']);

    // Reopened, then cleared again.
    const reopened = await ok<Plan>(
      await put(`/admissions/${stay.id}/discharge-plan/clearances/pharmacy`, { status: 'pending' }),
    );
    expect(reopened.clearances[1]?.status).toBe('pending');
    await ok(
      await put(`/admissions/${stay.id}/discharge-plan/clearances/pharmacy`, { status: 'cleared' }),
    );
    await ok(
      await put(`/admissions/${stay.id}/discharge-plan/clearances/lab`, { status: 'cleared' }),
    );
    await ok(
      await post(`/admissions/${stay.id}/discharge`, { dischargeType: 'routine', version: 1 }),
    );

    // A discharged stay takes no more advice or clearances.
    expect(errorOf(await put(`/admissions/${stay.id}/discharge-plan`, { advice: 'More' }))).toEqual(
      [409, 'invalid_transition'],
    );
    expect(
      errorOf(
        await put(`/admissions/${stay.id}/discharge-plan/clearances/lab`, { status: 'pending' }),
      ),
    ).toEqual([409, 'invalid_transition']);
  });

  it('needs the permissions and stays inside the hospital', async () => {
    const stay = await admit();
    expect(
      errorOf(await put(`/admissions/${stay.id}/discharge-plan`, { advice: 'x' }, { user: nurse })),
    ).toEqual([403, 'permission_denied']);
    // A nurse may clear.
    await ok(
      await put(
        `/admissions/${stay.id}/discharge-plan/clearances/nursing`,
        { status: 'cleared' },
        { user: nurse },
      ),
    );
    expect(
      errorOf(
        await put(`/admissions/${stay.id}/discharge-plan/clearances/dental`, { status: 'cleared' }),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await get(`/admissions/${stay.id}/discharge-plan`, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'admission_not_found']);
    expect(
      errorOf(
        await put(
          `/admissions/${stay.id}/discharge-plan/clearances/lab`,
          { status: 'cleared' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'admission_not_found']);
  });
});

describe('the discharge summary', () => {
  const sections = {
    diagnoses: 'Pneumonia',
    procedures: '',
    course: 'Recovered on antibiotics',
    results: '',
    medicines: '',
    followUp: '',
  };

  it('is a draft until signed, then never changes, and a correction is an addendum', async () => {
    const stay = await admit();
    const url = `/admissions/${stay.id}/discharge-summary`;
    expect(errorOf(await get(url))).toEqual([404, 'summary_not_found']);

    const draft = await ok<Summary>(await put(url, sections));
    expect(draft).toMatchObject({ status: 'draft', version: 1, diagnoses: 'Pneumonia' });
    // A second first-save, or an edit from a stale version, is a conflict.
    expect(errorOf(await put(url, sections))).toEqual([409, 'conflict']);
    const edited = await ok<Summary>(
      await put(url, { ...sections, procedures: 'Chest drain', version: 1 }),
    );
    expect(edited.version).toBe(2);
    expect(errorOf(await put(url, { ...sections, version: 1 }))).toEqual([409, 'conflict']);

    expect(errorOf(await post(`${url}/print`, undefined))).toEqual([409, 'summary_not_signed']);
    expect(errorOf(await post(`${url}/addenda`, { body: 'Late' }))).toEqual([
      409,
      'summary_not_signed',
    ]);
    expect(errorOf(await post(`${url}/sign`, { version: 1 }))).toEqual([409, 'conflict']);

    const signed = await ok<Summary>(await post(`${url}/sign`, { version: 2 }));
    expect(signed).toMatchObject({ status: 'signed', signedByName: 'Stay Admin', version: 3 });
    expect(errorOf(await put(url, { ...sections, version: 3 }))).toEqual([409, 'summary_signed']);
    expect(errorOf(await post(`${url}/sign`, { version: 3 }))).toEqual([409, 'summary_signed']);

    // The database refuses it too.
    await expect(
      pool.query(`update discharge_summaries set course = 'Changed' where admission_id = $1`, [
        stay.id,
      ]),
    ).rejects.toThrow();

    const key = randomUUID();
    const withAddendum = await ok<Summary>(
      await post(`${url}/addenda`, { body: 'Culture grew nothing' }, { key }),
    );
    expect(withAddendum.addenda.map((each) => each.body)).toEqual(['Culture grew nothing']);
    expect(withAddendum.version).toBe(4);
    await ok(await post(`${url}/addenda`, { body: 'Culture grew nothing' }, { key }));
    expect((await ok<Summary>(await get(url))).addenda).toHaveLength(1);
    expect((await post(`${url}/print`, undefined)).statusCode).toBe(204);

    const { rows } = await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and entity = 'discharge_summary' and entity_id = $2 order by at`,
      [hospital.id, stay.id],
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['create', 'update', 'sign', 'print', 'read']),
    );
  });

  it('wants a diagnosis and a course to sign, and the right permissions', async () => {
    const stay = await admit();
    const url = `/admissions/${stay.id}/discharge-summary`;
    await ok(await put(url, { ...sections, diagnoses: '' }));
    expect(errorOf(await post(`${url}/sign`, { version: 1 }))).toEqual([422, 'summary_incomplete']);
    expect(errorOf(await put(url, { ...sections, version: 1 }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await post(`${url}/sign`, { version: 1 }, { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    // A nurse reads.
    expect((await get(url, { user: nurse })).statusCode).toBe(200);
  });

  it('is not visible to another hospital', async () => {
    const stay = await admit();
    const url = `/admissions/${stay.id}/discharge-summary`;
    await ok(await put(url, sections));
    for (const response of [
      await get(url, { tenant: clinic, user: clinicAdmin }),
      await put(url, sections, { tenant: clinic, user: clinicAdmin }),
      await post(`${url}/sign`, { version: 1 }, { tenant: clinic, user: clinicAdmin }),
    ]) {
      expect(errorOf(response)).toEqual([404, 'admission_not_found']);
    }
    // The row-level security of the new tables: each hospital counts only its own rows.
    for (const table of ['discharge_plans', 'discharge_summaries', 'deposits']) {
      const counts: number[] = [];
      for (const tenant of [hospital, clinic]) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('set local role mediflow_app');
          await client.query("select set_config('app.tenant_id', $1, true)", [tenant.id]);
          const { rows } = await client.query(`select count(*)::int as n from ${table}`);
          await client.query('rollback');
          counts.push(rows[0]?.n ?? -1);
        } finally {
          client.release();
        }
      }
      expect(counts[0], table).toBeGreaterThan(0);
      expect(counts[1], table).toBe(0);
    }
  });
});
