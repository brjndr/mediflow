import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Corporate credit through the real app and database: accounts, bills for a visit, receipts set
 * against the oldest bills, statements, reconciliation, the hospital boundary, permissions, audit
 * and the database's own refusals.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let receptionist: TestUser;
let nurse: TestUser;
let clinicAdmin: TestUser;
let service: string;

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
const fresh = () => `crd-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const put = (url: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PUT', url, headers: headers(options), payload: body });
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
  'credit_receipt_allocations',
  'credit_receipts',
  'credit_bills',
  'credit_counters',
  'credit_accounts',
  'payers',
];
const allOn = { insurance: true, patients: true, billing: true };

interface Account {
  payerId: string;
  creditLimitMinor: number;
  termsDays: number;
  billedMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  availableMinor: number;
  version: number;
}
interface Bill {
  id: string;
  number: string;
  encounterId: string;
  issuedOn: string;
  dueOn: string;
  amountMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
  status: string;
  overdue: boolean;
}
interface Receipt {
  id: string;
  number: string;
  amountMinor: number;
  allocations: { billId: string; billNumber: string; amountMinor: number }[];
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Statement {
  openingMinor: number;
  billedMinor: number;
  receivedMinor: number;
  closingMinor: number;
  items: {
    kind: string;
    number: string;
    debitMinor: number;
    creditMinor: number;
    balanceMinor: number;
  }[];
  nextCursor: string | null;
}

const one = async (sql: string, params: unknown[]) =>
  ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let codes = 0;
async function corporate(kind = 'corporate', tenant = hospital, user = admin): Promise<string> {
  const made = await ok<{ id: string }>(
    await post(
      '/payers',
      { kind, code: `CR${++codes}`, name: `Credit Org ${codes}` },
      { tenant, user },
    ),
    201,
  );
  return made.id;
}
const open = async (limit = 1_000_000, terms = 30, kind = 'corporate') => {
  const payerId = await corporate(kind);
  const account = await ok<Account>(
    await put(`/payers/${payerId}/credit-account`, { creditLimitMinor: limit, termsDays: terms }),
  );
  return { payerId, account };
};

let mrn = 0;
/** A new patient with a visit whose ledger holds `prices`. */
async function visit(prices: number[], tenant: TestTenant = hospital) {
  const patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Crd', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CR-${String(++mrn).padStart(7, '0')}`],
  );
  const encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [tenant.id, patientId, admin.id],
  );
  for (const price of prices) {
    await pool.query(
      `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
         description, quantity, unit_price_minor)
       values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, $6)`,
      [tenant.id, encounterId, patientId, service, `crd-test:${++keys}`, price],
    );
  }
  return { patientId, encounterId };
}
const bill = (encounterId: string, payerId: string, options: Options = {}) =>
  post(`/encounters/${encounterId}/credit-bills`, { payerId }, options);
const billed = async (payerId: string, prices: number[]) =>
  ok<Bill>(await bill((await visit(prices)).encounterId, payerId), 201);
const receive = (payerId: string, amountMinor: number, extra: object = {}, options: Options = {}) =>
  post(
    `/payers/${payerId}/receipts`,
    { amountMinor, method: 'bank_transfer', receivedOn: day(0), ...extra },
    options,
  );
/** Moves bills back in time; the guard trigger allows nothing else, so it is switched off here. */
async function backdate(ids: string[], issued: number, due: number) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      'update credit_bills set issued_on = $2::date, due_on = $3::date where id = any($1)',
      [ids, day(issued), day(due)],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
}
const accountOf = async (payerId: string) =>
  ok<Account>(await get(`/payers/${payerId}/credit-account`));

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Credit Hospital', { features: allOn });
  clinic = await createTenant(pool, 'Credit Clinic', { features: allOn });
  closed = await createTenant(pool, 'Credit Closed', { features: { insurance: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Credit Admin', { withPassword: false });
  receptionist = await createUser(pool, 'Credit Desk', { withPassword: false });
  nurse = await createUser(pool, 'Credit Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Credit Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  service = await one(
    `insert into services (tenant_id, code, name, category, tax_class) values ($1, 'CRD-A', 'Credit Service', 'procedure', 'exempt') returning id`,
    [hospital.id],
  );
}, 60_000);

afterAll(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      for (const table of [...TABLES, 'charges', 'encounters', 'services', 'patients']) {
        await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
      }
      await client.query('commit');
    } finally {
      client.release();
    }
    await deleteUsers(pool, [admin, receptionist, nurse, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('credit accounts', () => {
  it('opens an account for a corporate, then changes it with the version', async () => {
    const payerId = await corporate();
    expect(errorOf(await get(`/payers/${payerId}/credit-account`))).toEqual([
      404,
      'credit_account_not_found',
    ]);
    const made = await ok<Account>(
      await put(`/payers/${payerId}/credit-account`, { creditLimitMinor: 500_000, termsDays: 45 }),
    );
    expect(made).toMatchObject({
      creditLimitMinor: 500_000,
      termsDays: 45,
      outstandingMinor: 0,
      availableMinor: 500_000,
      version: 1,
    });
    expect(await audited('credit_account', payerId)).toEqual(['create']);

    const changed = await ok<Account>(
      await put(`/payers/${payerId}/credit-account`, {
        creditLimitMinor: 700_000,
        termsDays: 15,
        version: 1,
      }),
    );
    expect(changed).toMatchObject({ creditLimitMinor: 700_000, termsDays: 15, version: 2 });
    expect(
      errorOf(
        await put(`/payers/${payerId}/credit-account`, {
          creditLimitMinor: 1,
          termsDays: 1,
          version: 1,
        }),
      ),
    ).toEqual([409, 'version_conflict']);
    // A change without the version, and a first save with one, are the same conflict.
    expect(
      errorOf(
        await put(`/payers/${payerId}/credit-account`, { creditLimitMinor: 1, termsDays: 1 }),
      ),
    ).toEqual([409, 'version_conflict']);
    const fresh2 = await corporate();
    expect(
      errorOf(
        await put(`/payers/${fresh2}/credit-account`, {
          creditLimitMinor: 1,
          termsDays: 1,
          version: 3,
        }),
      ),
    ).toEqual([409, 'version_conflict']);
    expect(await audited('credit_account', payerId)).toEqual(['create', 'update']);
  });

  it('refuses an insurer, an unknown organisation and a limit below what is owed', async () => {
    const insurer = await corporate('insurer');
    expect(
      errorOf(
        await put(`/payers/${insurer}/credit-account`, { creditLimitMinor: 1, termsDays: 1 }),
      ),
    ).toEqual([422, 'not_corporate']);
    expect(
      errorOf(
        await put('/payers/00000000-0000-4000-8000-000000000000/credit-account', {
          creditLimitMinor: 1,
          termsDays: 1,
        }),
      ),
    ).toEqual([404, 'payer_not_found']);
    expect(errorOf(await get('/payers/nope/credit-account'))[1]).toBe('payer_not_found');

    const { payerId } = await open(100_000);
    await billed(payerId, [60_000]);
    expect(
      errorOf(
        await put(`/payers/${payerId}/credit-account`, {
          creditLimitMinor: 59_999,
          termsDays: 30,
          version: 1,
        }),
      ),
    ).toEqual([422, 'below_outstanding']);
    const same = await ok<Account>(
      await put(`/payers/${payerId}/credit-account`, {
        creditLimitMinor: 60_000,
        termsDays: 30,
        version: 1,
      }),
    );
    expect(same.availableMinor).toBe(0);
  });

  it('lists accounts with the largest balance first, in pages', async () => {
    const low = await open(900_000);
    const high = await open(900_000);
    await billed(low.payerId, [10_000]);
    await billed(high.payerId, [80_000]);
    const first = await ok<Page<Account>>(await get('/credit-accounts?limit=1'));
    expect(first.items[0]?.payerId).toBe(high.payerId);
    expect(first.nextCursor).not.toBeNull();
    const seen = [first.items[0]?.payerId];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await ok<Page<Account>>(await get(`/credit-accounts?limit=1&cursor=${cursor}`));
      seen.push(next.items[0]?.payerId);
      cursor = next.nextCursor;
    }
    expect(seen.indexOf(high.payerId)).toBeLessThan(seen.indexOf(low.payerId));
    expect(new Set(seen).size).toBe(seen.length);
    expect(first.total).toBe(seen.length);
    expect(errorOf(await get('/credit-accounts?cursor=garbage'))).toEqual([400, 'invalid_cursor']);
  });
});

describe('credit bills', () => {
  it('bills the visit ledger, void charges left out, due after the terms', async () => {
    const { payerId } = await open(1_000_000, 10);
    const { patientId, encounterId } = await visit([30_000, 20_000]);
    await pool.query(
      `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
         description, quantity, unit_price_minor, status)
       values ($1, $2, $3, $4, 'manual', 'crd-void', 'Voided', 1, 999, 'void')`,
      [hospital.id, encounterId, patientId, service],
    );
    const made = await ok<Bill>(await bill(encounterId, payerId), 201);
    expect(made).toMatchObject({
      amountMinor: 50_000,
      receivedMinor: 0,
      outstandingMinor: 50_000,
      status: 'open',
      overdue: false,
      issuedOn: day(0),
      dueOn: day(10),
      encounterId,
    });
    expect(made.number).toMatch(/^CB-\d{6}$/);
    expect(await audited('credit_bill', made.id)).toEqual(['create']);
    const account = await accountOf(payerId);
    expect(account).toMatchObject({
      billedMinor: 50_000,
      outstandingMinor: 50_000,
      availableMinor: 950_000,
    });
  });

  it('numbers bills without gaps and refuses a second bill for a visit', async () => {
    const { payerId } = await open();
    const first = await billed(payerId, [1_000]);
    const second = await billed(payerId, [2_000]);
    expect(Number(second.number.slice(3))).toBe(Number(first.number.slice(3)) + 1);
    expect(errorOf(await bill(first.encounterId, payerId))).toEqual([409, 'credit_bill_exists']);
    const other = await open();
    expect(errorOf(await bill(first.encounterId, other.payerId))).toEqual([
      409,
      'credit_bill_exists',
    ]);
  });

  it('refuses an empty ledger, a bill over the limit, a missing account and an unknown visit', async () => {
    const { payerId } = await open(10_000);
    const empty = await visit([]);
    expect(errorOf(await bill(empty.encounterId, payerId))).toEqual([422, 'nothing_to_bill']);
    const big = await visit([10_001]);
    expect(errorOf(await bill(big.encounterId, payerId))).toEqual([422, 'credit_limit_exceeded']);
    const exact = await visit([10_000]);
    await ok(await bill(exact.encounterId, payerId), 201);
    const more = await visit([1]);
    expect(errorOf(await bill(more.encounterId, payerId))).toEqual([422, 'credit_limit_exceeded']);

    const none = await corporate();
    expect(errorOf(await bill(more.encounterId, none))).toEqual([404, 'credit_account_not_found']);
    expect(errorOf(await bill('00000000-0000-4000-8000-000000000000', payerId))).toEqual([
      404,
      'encounter_not_found',
    ]);
  });

  it('replays an idempotent request without a second bill', async () => {
    const { payerId } = await open();
    const { encounterId } = await visit([5_000]);
    const key = fresh();
    const a = await bill(encounterId, payerId, { key });
    const b = await bill(encounterId, payerId, { key });
    expect(a.statusCode).toBe(201);
    expect(b.json<Bill>().id).toBe(a.json<Bill>().id);
    const list = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills`));
    expect(list.items).toHaveLength(1);
  });

  it('lists the bills oldest first, by status, in pages; past-due money is overdue', async () => {
    const { payerId } = await open(1_000_000, 30);
    const a = await billed(payerId, [1_000]);
    const b = await billed(payerId, [2_000]);
    const c = await billed(payerId, [3_000]);
    await ok(await receive(payerId, 1_000), 201); // pays a
    await ok(await receive(payerId, 500), 201); // part pays b
    const all = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills`));
    expect(all.items.map((item) => [item.id, item.status])).toEqual([
      [a.id, 'paid'],
      [b.id, 'part_paid'],
      [c.id, 'open'],
    ]);
    expect(all.total).toBe(3);
    const paged = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills?limit=2`));
    expect(paged.items).toHaveLength(2);
    const rest = await ok<Page<Bill>>(
      await get(`/payers/${payerId}/credit-bills?limit=2&cursor=${paged.nextCursor}`),
    );
    expect(rest.items.map((item) => item.id)).toEqual([c.id]);
    expect(rest.nextCursor).toBeNull();
    const openOnes = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills?status=open`));
    expect(openOnes.items.map((item) => item.id)).toEqual([c.id]);
    expect(openOnes.total).toBe(1);

    await backdate([b.id, c.id], -5, -2);
    const late = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills`));
    expect(late.items.map((item) => item.overdue)).toEqual([false, true, true]);
    expect((await accountOf(payerId)).overdueMinor).toBe(1_500 + 3_000);
    expect(errorOf(await get(`/payers/${payerId}/credit-bills?cursor=junk`))[1]).toBe(
      'invalid_cursor',
    );
  });
});

describe('receipts', () => {
  it('sets money against the oldest unpaid bills first in one go', async () => {
    const { payerId } = await open();
    const a = await billed(payerId, [10_000]);
    const b = await billed(payerId, [20_000]);
    const c = await billed(payerId, [30_000]);
    const made = await ok<Receipt>(await receive(payerId, 25_000, { reference: 'UTR-1' }), 201);
    expect(made.number).toMatch(/^RC-\d{6}$/);
    expect(made.allocations).toEqual([
      { billId: a.id, billNumber: a.number, amountMinor: 10_000 },
      { billId: b.id, billNumber: b.number, amountMinor: 15_000 },
    ]);
    expect(made.allocations.reduce((sum, part) => sum + part.amountMinor, 0)).toBe(25_000);
    expect(await audited('credit_receipt', made.id)).toEqual(['create']);

    const bills = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills`));
    expect(bills.items.map((item) => item.receivedMinor)).toEqual([10_000, 15_000, 0]);
    const next = await ok<Receipt>(await receive(payerId, 35_000), 201);
    expect(next.allocations.map((part) => [part.billId, part.amountMinor])).toEqual([
      [b.id, 5_000],
      [c.id, 30_000],
    ]);
    expect(errorOf(await receive(payerId, 1))).toEqual([422, 'exceeds_outstanding']);
  });

  it('lists receipts newest first, with where each went', async () => {
    const { payerId } = await open();
    await billed(payerId, [9_000]);
    const one1 = await ok<Receipt>(await receive(payerId, 1_000), 201);
    const two = await ok<Receipt>(await receive(payerId, 2_000), 201);
    const three = await ok<Receipt>(await receive(payerId, 3_000), 201);
    const page = await ok<Page<Receipt>>(await get(`/payers/${payerId}/receipts?limit=2`));
    expect(page.items.map((item) => item.id)).toEqual([three.id, two.id]);
    expect(page.items[0]?.allocations).toHaveLength(1);
    expect(page.total).toBe(3);
    const rest = await ok<Page<Receipt>>(
      await get(`/payers/${payerId}/receipts?limit=2&cursor=${page.nextCursor}`),
    );
    expect(rest.items.map((item) => item.id)).toEqual([one1.id]);
    expect(rest.nextCursor).toBeNull();
  });

  it('refuses a future date, a date before the bill, a bad amount and a missing account', async () => {
    const { payerId } = await open();
    expect(errorOf(await receive(payerId, 100))).toEqual([422, 'exceeds_outstanding']);
    await billed(payerId, [5_000]);
    expect(errorOf(await receive(payerId, 100, { receivedOn: day(2) }))).toEqual([
      422,
      'future_date',
    ]);
    expect(errorOf(await receive(payerId, 100, { receivedOn: day(-1) }))).toEqual([
      422,
      'before_bill',
    ]);
    expect((await receive(payerId, 0)).statusCode).toBe(400);
    expect((await receive(payerId, 100, { method: 'barter' })).statusCode).toBe(400);
    const none = await corporate();
    expect(errorOf(await receive(none, 100))).toEqual([404, 'credit_account_not_found']);
    expect(errorOf(await receive('nope', 100))[1]).toBe('payer_not_found');
    // Nothing above left a trace.
    const list = await ok<Page<Receipt>>(await get(`/payers/${payerId}/receipts`));
    expect(list.items).toHaveLength(0);
  });

  it('replays an idempotent receipt without taking the money twice', async () => {
    const { payerId } = await open();
    await billed(payerId, [8_000]);
    const key = fresh();
    const a = await receive(payerId, 3_000, {}, { key });
    const b = await receive(payerId, 3_000, {}, { key });
    expect(b.json<Receipt>().id).toBe(a.json<Receipt>().id);
    expect((await accountOf(payerId)).receivedMinor).toBe(3_000);
  });

  it('never allocates more than is owed when two receipts race', async () => {
    const { payerId } = await open();
    await billed(payerId, [10_000]);
    const results = await Promise.all([receive(payerId, 7_000), receive(payerId, 7_000)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    expect((await accountOf(payerId)).outstandingMinor).toBe(3_000);
  });
});

describe('statements and reconciliation', () => {
  it('shows the opening balance, every line with a running balance, and the closing balance', async () => {
    const { payerId } = await open();
    const old = await billed(payerId, [40_000]);
    await billed(payerId, [10_000]);
    await ok(await receive(payerId, 15_000), 201);
    // The first bill is last month's.
    await backdate([old.id], -40, -10);
    const statement = await ok<Statement>(
      await get(`/payers/${payerId}/credit-statement?from=${day(-5)}&to=${day(0)}`),
    );
    expect(statement.openingMinor).toBe(40_000);
    expect(statement.billedMinor).toBe(10_000);
    expect(statement.receivedMinor).toBe(15_000);
    expect(statement.closingMinor).toBe(35_000);
    expect(statement.items.map((line) => [line.kind, line.balanceMinor])).toEqual([
      ['bill', 50_000],
      ['receipt', 35_000],
    ]);
    // Closing balance of a period that runs to today is what the account owes.
    expect(statement.closingMinor).toBe((await accountOf(payerId)).outstandingMinor);
  });

  it('pages the lines and keeps the totals for the whole period', async () => {
    const { payerId } = await open();
    for (const price of [1_000, 2_000, 3_000]) await billed(payerId, [price]);
    await ok(await receive(payerId, 1_500), 201);
    const url = `/payers/${payerId}/credit-statement?from=${day(-1)}&to=${day(0)}`;
    const first = await ok<Statement>(await get(`${url}&limit=2`));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.billedMinor).toBe(6_000);
    const second = await ok<Statement>(await get(`${url}&limit=2&cursor=${first.nextCursor}`));
    expect(second.items.map((line) => line.balanceMinor)).toEqual([6_000, 4_500]);
    expect(second.nextCursor).toBeNull();
    expect(errorOf(await get(`${url}&cursor=junk`))[1]).toBe('invalid_cursor');
  });

  it('refuses a period that ends before it starts, or a missing account', async () => {
    const { payerId } = await open();
    expect(
      errorOf(await get(`/payers/${payerId}/credit-statement?from=${day(0)}&to=${day(-1)}`)),
    ).toEqual([422, 'invalid_period']);
    expect((await get(`/payers/${payerId}/credit-statement?from=2026-01-01`)).statusCode).toBe(400);
    const none = await corporate();
    expect(
      errorOf(await get(`/payers/${none}/credit-statement?from=${day(-1)}&to=${day(0)}`)),
    ).toEqual([404, 'credit_account_not_found']);
  });

  it('reconciles: owed is billed less received, per account, per bill and per receipt', async () => {
    const { payerId } = await open();
    await billed(payerId, [12_345]);
    await billed(payerId, [6_789]);
    await billed(payerId, [100]);
    for (const amount of [5_000, 7_000, 1_234]) await ok(await receive(payerId, amount), 201);
    const account = await accountOf(payerId);
    expect(account.outstandingMinor).toBe(account.billedMinor - account.receivedMinor);
    expect(account.billedMinor).toBe(19_234);
    expect(account.receivedMinor).toBe(13_234);
    const bills = await ok<Page<Bill>>(await get(`/payers/${payerId}/credit-bills`));
    expect(bills.items.reduce((sum, item) => sum + item.receivedMinor, 0)).toBe(
      account.receivedMinor,
    );
    expect(bills.items.reduce((sum, item) => sum + item.amountMinor, 0)).toBe(account.billedMinor);
    const receipts = await ok<Page<Receipt>>(await get(`/payers/${payerId}/receipts`));
    for (const receipt of receipts.items) {
      expect(receipt.allocations.reduce((sum, part) => sum + part.amountMinor, 0)).toBe(
        receipt.amountMinor,
      );
    }
    expect(receipts.items.reduce((sum, item) => sum + item.amountMinor, 0)).toBe(
      account.receivedMinor,
    );
  });
});

describe('boundaries', () => {
  it('keeps hospitals, permissions and the switch apart', async () => {
    const { payerId } = await open();
    const made = await billed(payerId, [4_000]);
    await ok(await receive(payerId, 1_000), 201);

    // Another hospital sees nothing of it.
    expect(
      errorOf(
        await get(`/payers/${payerId}/credit-account`, { tenant: clinic, user: clinicAdmin }),
      )[1],
    ).toBe('payer_not_found');
    const theirs = await ok<Page<Account>>(
      await get('/credit-accounts', { tenant: clinic, user: clinicAdmin }),
    );
    expect(theirs.items).toHaveLength(0);
    expect(
      errorOf(
        await post(
          `/encounters/${made.encounterId}/credit-bills`,
          { payerId },
          { tenant: clinic, user: clinicAdmin },
        ),
      )[1],
    ).toBe('encounter_not_found');
    expect(errorOf(await receive(payerId, 100, {}, { tenant: clinic, user: clinicAdmin }))[1]).toBe(
      'payer_not_found',
    );
    for (const table of [
      'credit_accounts',
      'credit_bills',
      'credit_receipts',
      'credit_receipt_allocations',
      'credit_counters',
    ]) {
      await asTenantSql(pool, clinic.id, async (client) => {
        const { rows } = await client.query(`select 1 from ${table}`);
        expect(rows, table).toHaveLength(0);
      });
    }

    // The front desk reads; only the admin changes, bills and receives. A nurse sees nothing.
    expect(
      (await get(`/payers/${payerId}/credit-account`, { user: receptionist })).statusCode,
    ).toBe(200);
    expect((await get('/credit-accounts', { user: receptionist })).statusCode).toBe(200);
    expect(
      (
        await put(
          `/payers/${payerId}/credit-account`,
          { creditLimitMinor: 9, termsDays: 1, version: 1 },
          { user: receptionist },
        )
      ).statusCode,
    ).toBe(403);
    expect((await receive(payerId, 100, {}, { user: receptionist })).statusCode).toBe(403);
    expect((await bill(made.encounterId, payerId, { user: receptionist })).statusCode).toBe(403);
    expect((await get('/credit-accounts', { user: nurse })).statusCode).toBe(403);
    expect((await get(`/payers/${payerId}/receipts`, { user: nurse })).statusCode).toBe(403);

    // The insurance switch off.
    expect(errorOf(await get('/credit-accounts', { tenant: closed }))[1]).toBe('feature_disabled');
  });

  it('is guarded by the database itself', async () => {
    const { payerId } = await open();
    const made = await billed(payerId, [5_000]);
    const receipt = await ok<Receipt>(await receive(payerId, 2_000), 201);
    const asHospital = <T>(run: (client: pg.PoolClient) => Promise<T>) =>
      asTenantSql(pool, hospital.id, run);
    await expect(
      asHospital((client) =>
        client.query('update credit_bills set amount_minor = 1 where id = $1', [made.id]),
      ),
    ).rejects.toThrow(/Only the money received/);
    await expect(
      asHospital((client) =>
        client.query('update credit_bills set received_minor = 5001 where id = $1', [made.id]),
      ),
    ).rejects.toThrow(/credit_bills_money/);
    await expect(
      asHospital((client) =>
        client.query('update credit_bills set received_minor = 0 where id = $1', [made.id]),
      ),
    ).rejects.toThrow(/not taken back/);
    await expect(
      asHospital((client) =>
        client.query('update credit_receipts set amount_minor = 1 where id = $1', [receipt.id]),
      ),
    ).rejects.toThrow();
    await expect(
      asHospital((client) =>
        client.query('delete from credit_receipts where id = $1', [receipt.id]),
      ),
    ).rejects.toThrow();
    await expect(
      asHospital((client) =>
        client.query('delete from credit_receipt_allocations where receipt_id = $1', [receipt.id]),
      ),
    ).rejects.toThrow();
    // A visit goes on one bill, whatever the code does.
    await expect(
      asHospital((client) =>
        client.query(
          `insert into credit_bills (seq, payer_id, encounter_id, issued_on, due_on, amount_minor, created_by)
           values (99999, $1, $2, current_date, current_date, 1, $3)`,
          [payerId, made.encounterId, admin.id],
        ),
      ),
    ).rejects.toThrow(/credit_bills_one_per_visit/);
  });
});
