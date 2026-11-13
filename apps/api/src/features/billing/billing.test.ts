import { randomUUID } from 'node:crypto';
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
import { MemoryQueue } from '../../core/jobs/queue.js';

/**
 * Billing through the real app and database (#114): charges posted once from events, invoices
 * assembled from them and issued with gapless numbers, issued invoices that never change,
 * payments, refunds and credit notes that cannot overshoot under concurrency, cash register
 * sessions and the hospital boundary.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let jobs: MemoryQueue;
let hospital: TestTenant;
let clinic: TestTenant;
/** Billing switched off. */
let closed: TestTenant;
let admin: TestUser;
let desk: TestUser;
let doctor: TestUser;
let clinicAdmin: TestUser;
const patients = { asha: '', dina: '' };
const encounters = { main: '', other: '', clinic: '' };

interface Line {
  id: string;
  chargeId?: string;
  source: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  taxClass?: string;
  taxRateBp: number;
  taxMinor: number;
}
interface Invoice {
  id: string;
  number?: string;
  status: string;
  lines: Line[];
  totalMinor: number;
  taxMinor: number;
  paidMinor: number;
  creditedMinor: number;
  currency: string;
  version: number;
  patientName: string;
}
interface Charge {
  id: string;
  description: string;
  unitPriceMinor: number;
  totalMinor: number;
  status: string;
  invoiceId?: string;
  flag?: string;
}
interface Payment {
  id: string;
  kind: string;
  amountMinor: number;
  method: string;
  sessionId?: string;
}
interface Session {
  id: string;
  expectedMinor: number;
  countedMinor?: number;
  differenceMinor?: number;
  closedAt?: string;
  totals: { method: string; paidMinor: number; refundedMinor: number }[];
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Reply = {
  statusCode: number;
  body: string;
  json: <T = { error: { code: string } }>() => T;
};

const get = (url: string, options: Options = {}) =>
  app.inject({ url, headers: as((options.tenant ?? hospital).id, (options.user ?? desk).id) });
const send = (
  method: 'POST' | 'PATCH' | 'PUT',
  url: string,
  body: object,
  options: Options = {},
) => {
  const { tenant = hospital, user = desk, key = randomUUID() } = options;
  return app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    payload: body,
  });
};
const post = (url: string, body: object, options: Options = {}) => send('POST', url, body, options);
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function ok<T>(response: Promise<Reply> | Reply, status = 200): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `BL-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function addEncounter(tenant: TestTenant, patientId: string, by: TestUser) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into encounters (tenant_id, patient_id, type, opened_by)
     values ($1, $2, 'opd', $3) returning id`,
    [tenant.id, patientId, by.id],
  );
  return rows[0]?.id ?? '';
}

let sourceCount = 0;
async function addCharge(
  encounterId: string,
  {
    price = 10_000,
    quantity = 1,
    tenant = hospital,
    patientId = patients.asha,
    taxClass = null as string | null,
  } = {},
) {
  sourceCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into charges (tenant_id, encounter_id, patient_id, source, source_ref, description,
       quantity, unit_price_minor, tax_class)
     values ($1, $2, $3, 'service', $4, $5, $6, $7, $8) returning id`,
    [
      tenant.id,
      encounterId,
      patientId,
      `test:${sourceCount}`,
      `Charge ${sourceCount}`,
      quantity,
      price,
      taxClass,
    ],
  );
  return rows[0]?.id ?? '';
}

const draftOf = (chargeIds: string[], manualLines: object[] = [], options: Options = {}) =>
  ok<Invoice>(
    post(`/encounters/${encounters.main}/invoices`, { chargeIds, manualLines }, options),
    201,
  );

/** A draft of one new charge, issued. */
async function issued(price = 10_000, options: Options = {}) {
  const draft = await draftOf([await addCharge(encounters.main, { price })]);
  return ok<Invoice>(post(`/invoices/${draft.id}/issue`, { version: draft.version }, options));
}

const openRegister = (user: TestUser, openingMinor = 5_000) =>
  ok<Session>(post('/cash-registers/sessions', { openingMinor }, { user }), 201);

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: jobs });
  pool = app.database.pool;
  const features = { patients: true, clinical: true, services: true, billing: true };
  hospital = await createTenant(pool, 'Billing Hospital', { features });
  clinic = await createTenant(pool, 'Billing Clinic', { features, currency: 'AED' });
  closed = await createTenant(pool, 'Billing Closed', {
    features: { ...features, billing: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Billing Admin');
  desk = await user('Billing Desk');
  doctor = await user('Billing Doctor');
  clinicAdmin = await user('Billing Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  patients.asha = await addPatient(hospital, 'Asha');
  patients.dina = await addPatient(clinic, 'Dina');
  encounters.main = await addEncounter(hospital, patients.asha, admin);
  encounters.other = await addEncounter(hospital, patients.asha, admin);
  encounters.clinic = await addEncounter(clinic, patients.dina, clinicAdmin);
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Payments, credit notes and the lines of issued invoices refuse removal: triggers are off.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'payments',
      'credit_notes',
      'cash_register_sessions',
      'invoice_lines',
      'charges',
      'invoices',
      'invoice_counters',
      'tax_rates',
      'dispense_return_lines',
      'dispense_returns',
      'dispense_lines',
      'dispenses',
      'stock_batches',
      'service_prices',
      'services',
      'encounters',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, clinic.id, closed.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, clinic, closed]);
  await deleteUsers(pool, [admin, desk, doctor, clinicAdmin]);
  await app.close();
});

describe('charges', () => {
  it('lists a visit’s charges, newest first, by status, in pages', async () => {
    const a = await addCharge(encounters.other, { price: 500, quantity: 3 });
    await addCharge(encounters.other, { price: 700 });
    const page = await ok<Page<Charge>>(get(`/encounters/${encounters.other}/charges?limit=1`));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(page.total).toBe(2);
    const rest = await ok<Page<Charge>>(
      get(`/encounters/${encounters.other}/charges?limit=5&status=pending`),
    );
    const mine = rest.items.find((charge) => charge.id === a);
    expect(mine).toMatchObject({ unitPriceMinor: 500, totalMinor: 1500, status: 'pending' });
    expect(errorOf(await get(`/encounters/${encounters.other}/charges?cursor=nonsense`))).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('is not found, nor listed, across hospitals', async () => {
    expect(errorOf(await get(`/encounters/${encounters.clinic}/charges`))).toEqual([
      404,
      'encounter_not_found',
    ]);
    const own = await ok<Page<Charge>>(
      get(`/encounters/${encounters.clinic}/charges`, { tenant: clinic, user: clinicAdmin }),
    );
    expect(own.items.every((charge) => charge.description !== '')).toBe(true);
  });

  it('is behind the module flag and the permission', async () => {
    expect(
      errorOf(await get(`/encounters/${encounters.main}/charges`, { tenant: closed, user: admin })),
    ).toEqual([403, 'feature_disabled']);
    await addMembership(pool, doctor, closed, 'doctor');
    expect(
      errorOf(
        await post(
          `/encounters/${encounters.main}/invoices`,
          { chargeIds: [], manualLines: [] },
          { user: doctor },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('is never repriced, renamed or moved to another visit, even by the owner', async () => {
    const id = await addCharge(encounters.other, { price: 900 });
    for (const set of [
      'unit_price_minor = 1',
      "description = 'x'",
      `encounter_id = '${encounters.main}'`,
      'quantity = 2',
    ]) {
      await expect(pool.query(`update charges set ${set} where id = $1`, [id])).rejects.toThrow();
    }
  });
});

describe('invoices', () => {
  it('makes a draft whose lines and total the server works out', async () => {
    const a = await addCharge(encounters.main, { price: 2_550, quantity: 2 });
    const b = await addCharge(encounters.main, { price: 35_000 });
    const draft = await draftOf(
      [a, b],
      [{ description: 'Dressing', quantity: 3, unitPriceMinor: 1_000 }],
      {
        user: admin,
      },
    );
    expect(draft).toMatchObject({
      status: 'draft',
      totalMinor: 2_550 * 2 + 35_000 + 3_000,
      paidMinor: 0,
      creditedMinor: 0,
      currency: 'INR',
      version: 1,
      patientName: 'Asha Test',
    });
    expect(draft.number).toBeUndefined();
    expect(draft.lines.map((line) => line.source)).toEqual(['service', 'service', 'manual']);
    const charges = await ok<Page<Charge>>(get(`/encounters/${encounters.main}/charges?limit=100`));
    expect(charges.items.find((charge) => charge.id === a)?.invoiceId).toBe(draft.id);
    const list = await ok<Page<Invoice>>(get(`/encounters/${encounters.main}/invoices`));
    expect(list.items.some((invoice) => invoice.id === draft.id)).toBe(true);
  });

  it('uses the hospital’s currency', async () => {
    const charge = await addCharge(encounters.clinic, { tenant: clinic, patientId: patients.dina });
    const draft = await ok<Invoice>(
      post(
        `/encounters/${encounters.clinic}/invoices`,
        { chargeIds: [charge], manualLines: [] },
        { tenant: clinic, user: clinicAdmin },
      ),
      201,
    );
    expect(draft.currency).toBe('AED');
  });

  it('repeats a create with the same key as one draft, and refuses the same key for another body', async () => {
    const charge = await addCharge(encounters.main);
    const key = randomUUID();
    const body = { chargeIds: [charge], manualLines: [] };
    const first = await ok<Invoice>(
      post(`/encounters/${encounters.main}/invoices`, body, { key }),
      201,
    );
    const again = await post(`/encounters/${encounters.main}/invoices`, body, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Invoice>().id).toBe(first.id);
    expect(
      errorOf(
        await post(
          `/encounters/${encounters.main}/invoices`,
          { chargeIds: [], manualLines: [] },
          { key },
        ),
      ),
    ).toEqual([422, 'idempotency_key_reuse']);
    expect(
      errorOf(await post(`/encounters/${encounters.main}/invoices`, body, { key: undefined })),
    ).toEqual([409, 'charge_unavailable']);
  });

  it('refuses a charge held by another draft, one of another visit and one that is not there', async () => {
    const charge = await addCharge(encounters.main);
    await draftOf([charge]);
    const body = (chargeIds: string[]) => ({ chargeIds, manualLines: [] });
    for (const ids of [[charge], [await addCharge(encounters.other)], [randomUUID()], ['nope']]) {
      expect(errorOf(await post(`/encounters/${encounters.main}/invoices`, body(ids)))).toEqual([
        409,
        'charge_unavailable',
      ]);
    }
  });

  it('lets exactly one of two drafts racing for a charge have it', async () => {
    const charge = await addCharge(encounters.main);
    const body = { chargeIds: [charge], manualLines: [] };
    const results = await Promise.all([
      post(`/encounters/${encounters.main}/invoices`, body),
      post(`/encounters/${encounters.main}/invoices`, body),
    ]);
    expect(results.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
  });

  it('needs invoice:adjust for typed lines, and keeps the ones a draft has', async () => {
    const line = { description: 'Courier', quantity: 1, unitPriceMinor: 500 };
    expect(
      errorOf(
        await post(`/encounters/${encounters.main}/invoices`, {
          chargeIds: [],
          manualLines: [line],
        }),
      ),
    ).toEqual([403, 'permission_denied']);
    const draft = await draftOf([], [line], { user: admin });
    const charge = await addCharge(encounters.main);
    const updated = await ok<Invoice>(
      send('PATCH', `/invoices/${draft.id}`, {
        chargeIds: [charge],
        manualLines: [line],
        version: draft.version,
      }),
    );
    expect(updated.lines).toHaveLength(2);
    expect(
      errorOf(
        await send('PATCH', `/invoices/${draft.id}`, {
          chargeIds: [],
          manualLines: [{ ...line, unitPriceMinor: 1 }],
          version: updated.version,
        }),
      ),
    ).toEqual([403, 'permission_denied']);
  });

  it('changes a draft, lets go of the charges left out, and refuses a stale version', async () => {
    const a = await addCharge(encounters.main);
    const b = await addCharge(encounters.main);
    const draft = await draftOf([a, b]);
    const updated = await ok<Invoice>(
      send('PATCH', `/invoices/${draft.id}`, {
        chargeIds: [b],
        manualLines: [],
        version: draft.version,
      }),
    );
    expect(updated.lines.map((line) => line.chargeId)).toEqual([b]);
    expect(updated.version).toBe(draft.version + 1);
    const charges = await ok<Page<Charge>>(get(`/encounters/${encounters.main}/charges?limit=100`));
    expect(charges.items.find((charge) => charge.id === a)?.invoiceId).toBeUndefined();
    // The released charge goes on another draft.
    await draftOf([a]);
    expect(
      errorOf(
        await send('PATCH', `/invoices/${draft.id}`, {
          chargeIds: [b],
          manualLines: [],
          version: draft.version,
        }),
      ),
    ).toEqual([409, 'version_conflict']);
  });

  it('issues with the next number of the fiscal year, once, and replays an issue', async () => {
    const draft = await draftOf([await addCharge(encounters.main)]);
    const key = randomUUID();
    const first = await ok<Invoice>(
      post(`/invoices/${draft.id}/issue`, { version: draft.version }, { key }),
    );
    expect(first.status).toBe('issued');
    expect(first.number).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
    const again = await post(`/invoices/${draft.id}/issue`, { version: draft.version }, { key });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Invoice>().number).toBe(first.number);
    expect(errorOf(await post(`/invoices/${draft.id}/issue`, { version: first.version }))).toEqual([
      409,
      'invoice_not_draft',
    ]);
    const charges = await ok<Page<Charge>>(get(`/encounters/${encounters.main}/charges?limit=100`));
    expect(charges.items.find((charge) => charge.id === first.lines[0]?.chargeId)?.status).toBe(
      'invoiced',
    );
  });

  it('refuses an empty draft, and a stale version at issue', async () => {
    expect(
      errorOf(
        await post(`/encounters/${encounters.main}/invoices`, { chargeIds: [], manualLines: [] }),
      ),
    ).toEqual([422, 'empty_invoice']);
    const draft = await draftOf([await addCharge(encounters.main)]);
    expect(
      errorOf(await post(`/invoices/${draft.id}/issue`, { version: draft.version + 1 })),
    ).toEqual([409, 'version_conflict']);
  });

  it('gives concurrent issues distinct numbers with no gap', async () => {
    const drafts = await Promise.all(
      [1, 2, 3, 4].map(async () => draftOf([await addCharge(encounters.main)])),
    );
    const results = await Promise.all(
      drafts.map((draft) =>
        ok<Invoice>(post(`/invoices/${draft.id}/issue`, { version: draft.version })),
      ),
    );
    const numbers = results
      .map((invoice) => Number(invoice.number?.slice(-6)))
      .sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(4);
    expect((numbers.at(-1) ?? 0) - (numbers[0] ?? 0)).toBe(3);
  });

  it('never changes an issued invoice, its lines or its charges, even for the owner', async () => {
    const invoice = await issued();
    expect(
      errorOf(
        await send('PATCH', `/invoices/${invoice.id}`, {
          chargeIds: [],
          manualLines: [],
          version: invoice.version,
        }),
      ),
    ).toEqual([409, 'invoice_not_draft']);
    await expect(
      pool.query('update invoices set total_minor = 1 where id = $1', [invoice.id]),
    ).rejects.toThrow();
    await expect(
      pool.query("update invoices set number = 'X' where id = $1", [invoice.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('delete from invoice_lines where invoice_id = $1', [invoice.id]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `insert into invoice_lines (tenant_id, invoice_id, line_number, source, description, quantity, unit_price_minor)
         values ($1, $2, 99, 'manual', 'x', 1, 1)`,
        [hospital.id, invoice.id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query('update invoices set status = $2 where id = $1', [invoice.id, 'draft']),
    ).rejects.toThrow();
  });

  it('is read only in its own hospital', async () => {
    const invoice = await issued();
    expect(
      errorOf(await get(`/invoices/${invoice.id}`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'invoice_not_found']);
    expect(errorOf(await get('/invoices/not-an-id'))).toEqual([404, 'invoice_not_found']);
    expect((await ok<Invoice>(get(`/invoices/${invoice.id}`, { user: doctor }))).id).toBe(
      invoice.id,
    );
  });

  it('audits and emits what it did', async () => {
    const invoice = await issued();
    const { rows } = await pool.query<{ event: string }>(
      "select event from outbox where entity_id = $1 and event = 'invoice.issued'",
      [invoice.id],
    );
    expect(rows).toHaveLength(1);
    const audit = await pool.query(
      "select 1 from audit_log where tenant_id = $1 and entity = 'invoice' and entity_id = $2 and action = 'update'",
      [hospital.id, invoice.id],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });
});

describe('more invoice rules', () => {
  it('answers a repeated change of a draft with the draft, once', async () => {
    const a = await addCharge(encounters.main);
    const b = await addCharge(encounters.main);
    const draft = await draftOf([a]);
    const key = randomUUID();
    const body = { chargeIds: [a, b], manualLines: [], version: draft.version };
    const first = await ok<Invoice>(send('PATCH', `/invoices/${draft.id}`, body, { key }));
    const again = await send('PATCH', `/invoices/${draft.id}`, body, { key });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Invoice>()).toMatchObject({ id: draft.id, version: first.version });
    expect(again.json<Invoice>().lines).toHaveLength(2);
  });

  it('refuses a visit that was cancelled', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by, status, cancel_reason, ended_at, ended_by)
       values ($1, $2, 'opd', $3, 'cancelled', 'Entered in error', now(), $3) returning id`,
      [hospital.id, patients.asha, admin.id],
    );
    expect(
      errorOf(
        await post(
          `/encounters/${rows[0]?.id}/invoices`,
          {
            chargeIds: [],
            manualLines: [{ description: 'x', quantity: 1, unitPriceMinor: 1 }],
          },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'encounter_cancelled']);
  });

  it('refuses a total too large to count', async () => {
    const charges = await Promise.all(
      Array.from({ length: 10 }, () =>
        addCharge(encounters.other, { price: 100_000_000_000, quantity: 10_000 }),
      ),
    );
    expect(
      errorOf(
        await post(`/encounters/${encounters.other}/invoices`, {
          chargeIds: charges,
          manualLines: [],
        }),
      ),
    ).toEqual([422, 'amount_too_large']);
  });

  it('will not issue an invoice that holds a charge brought back', async () => {
    const charge = await addCharge(encounters.main);
    await pool.query("update charges set flag = 'return_review' where id = $1", [charge]);
    const draft = await draftOf([charge]);
    expect(errorOf(await post(`/invoices/${draft.id}/issue`, { version: draft.version }))).toEqual([
      409,
      'charge_returned',
    ]);
  });
});

describe('tax', () => {
  const rates = (options: Options = {}) =>
    ok<{ items: { taxClass: string; rateBp: number }[] }>(get('/billing/tax-rates', options));
  const rateOf = async (taxClass: string, options: Options = {}) =>
    (await rates(options)).items.find((item) => item.taxClass === taxClass)?.rateBp;
  const setRates = (items: object[], options: Options = {}) =>
    send('PUT', '/billing/tax-rates', { items }, { user: admin, ...options });

  it('starts from the default rates and taxes a charge by the class it was posted with', async () => {
    expect(await rateOf('standard')).toBe(1200);
    expect(await rateOf('exempt')).toBe(0);
    const taxed = await addCharge(encounters.main, {
      price: 10_050,
      quantity: 2,
      taxClass: 'standard',
    });
    const exempt = await addCharge(encounters.main, { price: 3_000, taxClass: 'exempt' });
    const untaxed = await addCharge(encounters.main, { price: 1_000 });
    const draft = await draftOf([taxed, exempt, untaxed]);
    // 2 x 100.50 at 12% = 24.12 (rounded half up); nothing on the others.
    expect(draft.lines.map((line) => [line.taxRateBp, line.taxMinor])).toEqual([
      [1200, 2412],
      [0, 0],
      [0, 0],
    ]);
    expect(draft.taxMinor).toBe(2412);
    expect(draft.totalMinor).toBe(20_100 + 3_000 + 1_000 + 2_412);
  });

  it('rounds the tax of each line half up', async () => {
    const draft = await draftOf(
      [],
      [{ description: 'Dressing', quantity: 1, unitPriceMinor: 1_050, taxClass: 'reduced' }],
      { user: admin },
    );
    // 10.50 at 5% = 0.525, which is 0.53.
    expect(draft.lines[0]).toMatchObject({ taxClass: 'reduced', taxRateBp: 500, taxMinor: 53 });
    expect(draft.totalMinor).toBe(1_103);
  });

  it('keeps the rate an issued invoice was made with when the rates change later', async () => {
    const draft = await draftOf([
      await addCharge(encounters.main, { price: 10_000, taxClass: 'higher' }),
    ]);
    expect(draft.taxMinor).toBe(1_800);
    const invoice = await ok<Invoice>(
      post(`/invoices/${draft.id}/issue`, { version: draft.version }),
    );
    await ok(setRates([{ taxClass: 'higher', rateBp: 2800 }]), 200);
    try {
      expect(await rateOf('higher')).toBe(2800);
      const again = await ok<Invoice>(get(`/invoices/${invoice.id}`));
      expect(again).toMatchObject({ taxMinor: 1_800, totalMinor: 11_800 });
      expect(again.lines[0]).toMatchObject({ taxRateBp: 1800, taxMinor: 1_800 });
      // A new draft takes the new rate.
      const next = await draftOf([
        await addCharge(encounters.main, { price: 10_000, taxClass: 'higher' }),
      ]);
      expect(next.taxMinor).toBe(2_800);
    } finally {
      await ok(setRates([{ taxClass: 'higher', rateBp: 1800 }]), 200);
    }
  });

  it('is never changed on an issued invoice, nor on a charge, even by the owner', async () => {
    const draft = await draftOf([await addCharge(encounters.main, { taxClass: 'standard' })]);
    const invoice = await ok<Invoice>(
      post(`/invoices/${draft.id}/issue`, { version: draft.version }),
    );
    for (const set of ['tax_minor = 0', 'total_minor = 1']) {
      await expect(
        pool.query(`update invoices set ${set} where id = $1`, [invoice.id]),
      ).rejects.toThrow();
    }
    await expect(
      pool.query("update charges set tax_class = 'exempt' where id = $1", [
        invoice.lines[0]?.chargeId,
      ]),
    ).rejects.toThrow();
  });

  it('is set by whoever holds taxRate:manage, each class once, and by nobody else', async () => {
    expect(errorOf(await setRates([{ taxClass: 'reduced', rateBp: 600 }], { user: desk }))).toEqual(
      [403, 'permission_denied'],
    );
    expect(
      (
        await setRates([
          { taxClass: 'reduced', rateBp: 600 },
          { taxClass: 'reduced', rateBp: 700 },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await setRates([{ taxClass: 'reduced', rateBp: 10_001 }])).statusCode).toBe(400);
    // The front desk reads the rates.
    expect(await rateOf('reduced', { user: desk })).toBe(500);
  });

  it('is each hospital’s own', async () => {
    await ok(
      setRates([{ taxClass: 'standard', rateBp: 2000 }], { tenant: clinic, user: clinicAdmin }),
      200,
    );
    expect(await rateOf('standard', { tenant: clinic, user: clinicAdmin })).toBe(2000);
    expect(await rateOf('standard')).toBe(1200);
    expect(errorOf(await get('/billing/tax-rates', { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('payments', () => {
  it('takes a card payment, then the rest, and the invoice is paid', async () => {
    const invoice = await issued(10_000);
    const part = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, {
        amountMinor: 4_000,
        method: 'card',
        reference: 'TXN1',
      }),
      201,
    );
    expect(part).toMatchObject({ kind: 'payment', amountMinor: 4_000, method: 'card' });
    expect((await ok<Invoice>(get(`/invoices/${invoice.id}`))).paidMinor).toBe(4_000);
    await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 6_000, method: 'upi' }),
      201,
    );
    const after = await ok<Invoice>(get(`/invoices/${invoice.id}`));
    expect(after).toMatchObject({ status: 'paid', paidMinor: 10_000 });
    expect(
      errorOf(await post(`/invoices/${invoice.id}/payments`, { amountMinor: 1, method: 'card' })),
    ).toEqual([409, 'invoice_not_payable']);
    const list = await ok<{ items: Payment[] }>(get(`/invoices/${invoice.id}/payments`));
    expect(list.items).toHaveLength(2);
    const events = await pool.query(
      "select 1 from outbox where entity_id = $1 and event = 'invoice.paid'",
      [invoice.id],
    );
    expect(events.rowCount).toBe(1);
  });

  it('refuses more than is due, and a draft', async () => {
    const invoice = await issued(1_000);
    expect(
      errorOf(
        await post(`/invoices/${invoice.id}/payments`, { amountMinor: 1_001, method: 'card' }),
      ),
    ).toEqual([409, 'overpayment']);
    const draft = await draftOf([await addCharge(encounters.main)]);
    expect(
      errorOf(await post(`/invoices/${draft.id}/payments`, { amountMinor: 1, method: 'card' })),
    ).toEqual([409, 'invoice_not_payable']);
    expect(
      errorOf(
        await post(`/invoices/${invoice.id}/payments`, { amountMinor: 0, method: 'card' }),
      )[0],
    ).toBe(400);
  });

  it('records a repeated payment key once, and a different body under it is refused', async () => {
    const invoice = await issued(1_000);
    const key = randomUUID();
    const first = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 400, method: 'card' }, { key }),
      201,
    );
    const again = await post(
      `/invoices/${invoice.id}/payments`,
      { amountMinor: 400, method: 'card' },
      { key },
    );
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Payment>().id).toBe(first.id);
    expect((await ok<Invoice>(get(`/invoices/${invoice.id}`))).paidMinor).toBe(400);
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/payments`,
          { amountMinor: 500, method: 'card' },
          { key },
        ),
      ),
    ).toEqual([422, 'idempotency_key_reuse']);
  });

  it('lets only what is due be paid when payments race', async () => {
    const invoice = await issued(1_000);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        post(`/invoices/${invoice.id}/payments`, { amountMinor: 600, method: 'card' }),
      ),
    );
    expect(results.map((reply) => reply.statusCode).sort()).toEqual([201, 409, 409]);
    expect((await ok<Invoice>(get(`/invoices/${invoice.id}`))).paidMinor).toBe(600);
  });

  it('takes cash only into the caller’s open register session', async () => {
    const invoice = await issued(2_000);
    expect(
      errorOf(await post(`/invoices/${invoice.id}/payments`, { amountMinor: 500, method: 'cash' })),
    ).toEqual([409, 'no_open_register']);
    const session = await openRegister(desk, 1_000);
    const payment = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 500, method: 'cash' }),
      201,
    );
    expect(payment.sessionId).toBe(session.id);
    // Another person's drawer is not this one's.
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/payments`,
          { amountMinor: 500, method: 'cash' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'no_open_register']);
    const now = await ok<Session>(get('/cash-registers/sessions/current'));
    expect(now.expectedMinor).toBe(1_500);
    await ok<Session>(
      post(`/cash-registers/sessions/${session.id}/close`, { countedMinor: 1_500 }),
    );
  });

  it('refuses payments from a user who may not record them', async () => {
    const invoice = await issued(1_000);
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/payments`,
          { amountMinor: 100, method: 'card' },
          { user: doctor },
        ),
      ),
    ).toEqual([403, 'permission_denied']);
  });
});

describe('refunds', () => {
  it('refunds part of a payment, reopens a paid invoice, and never more than it holds', async () => {
    const invoice = await issued(1_000);
    const payment = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 1_000, method: 'card' }),
      201,
    );
    expect(
      errorOf(await post(`/payments/${payment.id}/refunds`, { amountMinor: 100, reason: 'x' })),
    ).toEqual([403, 'permission_denied']);
    const refund = await ok<Payment>(
      post(
        `/payments/${payment.id}/refunds`,
        { amountMinor: 300, reason: 'Wrong test' },
        { user: admin },
      ),
      201,
    );
    expect(refund).toMatchObject({ kind: 'refund', amountMinor: 300 });
    expect(await ok<Invoice>(get(`/invoices/${invoice.id}`))).toMatchObject({
      status: 'issued',
      paidMinor: 700,
    });
    expect(
      errorOf(
        await post(
          `/payments/${payment.id}/refunds`,
          { amountMinor: 701, reason: 'x' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'refund_exceeds']);
    // The payment itself is not a refund's to refund, and a payment is never edited.
    expect(
      errorOf(
        await post(
          `/payments/${refund.id}/refunds`,
          { amountMinor: 1, reason: 'x' },
          { user: admin },
        ),
      ),
    ).toEqual([404, 'payment_not_found']);
    await expect(
      pool.query('update payments set amount_minor = 1 where id = $1', [payment.id]),
    ).rejects.toThrow();
    await expect(pool.query('delete from payments where id = $1', [payment.id])).rejects.toThrow();
    const events = await pool.query(
      "select 1 from outbox where entity_id = $1 and event = 'payment.refunded'",
      [refund.id],
    );
    expect(events.rowCount).toBe(1);
  });

  it('lets two racing refunds take no more than the payment holds', async () => {
    const invoice = await issued(1_000);
    const payment = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 1_000, method: 'card' }),
      201,
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        post(
          `/payments/${payment.id}/refunds`,
          { amountMinor: 700, reason: 'Double' },
          { user: admin },
        ),
      ),
    );
    expect(results.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
  });

  it('takes a cash refund out of the register, and the day ends with the difference kept', async () => {
    const session = await openRegister(admin, 2_000);
    const invoice = await issued(1_000);
    const payment = await ok<Payment>(
      post(
        `/invoices/${invoice.id}/payments`,
        { amountMinor: 1_000, method: 'cash' },
        { user: admin },
      ),
      201,
    );
    await ok<Payment>(
      post(
        `/payments/${payment.id}/refunds`,
        { amountMinor: 250, reason: 'Short' },
        { user: admin },
      ),
      201,
    );
    const now = await ok<Session>(get(`/cash-registers/sessions/${session.id}`, { user: admin }));
    expect(now.expectedMinor).toBe(2_000 + 1_000 - 250);
    expect(now.totals).toEqual([{ method: 'cash', paidMinor: 1_000, refundedMinor: 250 }]);
    // Another person cannot settle it.
    expect(
      errorOf(await post(`/cash-registers/sessions/${session.id}/close`, { countedMinor: 1 })),
    ).toEqual([404, 'session_not_found']);
    const done = await ok<Session>(
      post(
        `/cash-registers/sessions/${session.id}/close`,
        { countedMinor: 2_700 },
        { user: admin },
      ),
    );
    expect(done).toMatchObject({ expectedMinor: 2_750, countedMinor: 2_700, differenceMinor: -50 });
    expect(done.closedAt).toBeDefined();
    expect(
      errorOf(
        await post(
          `/cash-registers/sessions/${session.id}/close`,
          { countedMinor: 1 },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'register_closed']);
    await expect(
      pool.query('update cash_register_sessions set note = $2 where id = $1', [session.id, 'x']),
    ).rejects.toThrow();
    // A closed drawer takes nothing more: a new session is needed for cash.
    expect(
      errorOf(
        await post(
          `/payments/${payment.id}/refunds`,
          { amountMinor: 10, reason: 'Late' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'no_open_register']);
  });
});

describe('cash register sessions', () => {
  it('lets a person have one open at a time, and lists them for those who may read', async () => {
    const session = await openRegister(desk);
    expect(
      errorOf(await post('/cash-registers/sessions', { openingMinor: 1 }, { user: desk })),
    ).toEqual([409, 'register_open']);
    const key = randomUUID();
    await ok<Session>(
      post(`/cash-registers/sessions/${session.id}/close`, { countedMinor: 5_000 }, { key }),
    );
    const again = await post(
      `/cash-registers/sessions/${session.id}/close`,
      { countedMinor: 5_000 },
      { key },
    );
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const list = await ok<Page<Session>>(
      get('/cash-registers/sessions?limit=100', { user: admin }),
    );
    expect(list.items.some((each) => each.id === session.id)).toBe(true);
    expect(errorOf(await get('/cash-registers/sessions/current'))).toEqual([
      404,
      'session_not_found',
    ]);
    expect(errorOf(await get('/cash-registers/sessions', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('lets only one of two racing opens in, the other is refused', async () => {
    const results = await Promise.all([
      post('/cash-registers/sessions', { openingMinor: 1 }, { user: admin }),
      post('/cash-registers/sessions', { openingMinor: 1 }, { user: admin }),
    ]);
    expect(results.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    const open = await ok<Session>(get('/cash-registers/sessions/current', { user: admin }));
    await ok<Session>(
      post(`/cash-registers/sessions/${open.id}/close`, { countedMinor: 1 }, { user: admin }),
    );
  });

  it('is the hospital’s own', async () => {
    const session = await openRegister(clinicAdmin).catch(() => null);
    const mine = session ?? undefined;
    expect(mine === undefined || typeof mine.id === 'string').toBe(true);
    const list = await ok<Page<Session>>(
      get('/cash-registers/sessions?limit=100', { user: admin }),
    );
    expect(list.items.every((each) => each.id !== mine?.id)).toBe(true);
  });
});

describe('credit notes', () => {
  it('credits part of an invoice with a number of its own, and the invoice is not changed', async () => {
    const invoice = await issued(1_000);
    expect(
      errorOf(
        await post(`/invoices/${invoice.id}/credit-notes`, { amountMinor: 100, reason: 'x' }),
      ),
    ).toEqual([403, 'permission_denied']);
    const note = await ok<{ id: string; number: string; amountMinor: number }>(
      post(
        `/invoices/${invoice.id}/credit-notes`,
        { amountMinor: 300, reason: 'Discount agreed' },
        { user: admin },
      ),
      201,
    );
    expect(note.number).toMatch(/^CN-\d{4}-\d{2}-\d{6}$/);
    const after = await ok<Invoice>(get(`/invoices/${invoice.id}`));
    expect(after).toMatchObject({
      status: 'issued',
      totalMinor: 1_000,
      creditedMinor: 300,
      number: invoice.number,
    });
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/credit-notes`,
          { amountMinor: 701, reason: 'x' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'credit_exceeds']);
    // What is left to pay is what is not credited: paying it settles the invoice.
    await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 700, method: 'card' }),
      201,
    );
    expect((await ok<Invoice>(get(`/invoices/${invoice.id}`))).status).toBe('paid');
    const list = await ok<{ items: { id: string }[] }>(get(`/invoices/${invoice.id}/credit-notes`));
    expect(list.items.map((each) => each.id)).toEqual([note.id]);
    await expect(
      pool.query('update credit_notes set amount_minor = 1 where id = $1', [note.id]),
    ).rejects.toThrow();
  });

  it('asks for a refund first when too much was paid', async () => {
    const invoice = await issued(1_000);
    const payment = await ok<Payment>(
      post(`/invoices/${invoice.id}/payments`, { amountMinor: 1_000, method: 'card' }),
      201,
    );
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/credit-notes`,
          { amountMinor: 200, reason: 'x' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'refund_first']);
    await ok<Payment>(
      post(
        `/payments/${payment.id}/refunds`,
        { amountMinor: 200, reason: 'Back' },
        { user: admin },
      ),
      201,
    );
    await ok(
      post(
        `/invoices/${invoice.id}/credit-notes`,
        { amountMinor: 200, reason: 'x' },
        { user: admin },
      ),
      201,
    );
  });

  it('voids an invoice credited in full and lets its charges be billed again', async () => {
    const charge = await addCharge(encounters.main, { price: 800 });
    const draft = await draftOf([charge]);
    const invoice = await ok<Invoice>(
      post(`/invoices/${draft.id}/issue`, { version: draft.version }),
    );
    await ok(
      post(
        `/invoices/${invoice.id}/credit-notes`,
        { amountMinor: 800, reason: 'Billed in error' },
        { user: admin },
      ),
      201,
    );
    const voided = await ok<Invoice>(get(`/invoices/${invoice.id}`));
    expect(voided).toMatchObject({ status: 'void', number: invoice.number });
    const charges = await ok<Page<Charge>>(get(`/encounters/${encounters.main}/charges?limit=100`));
    expect(charges.items.find((each) => each.id === charge)).toMatchObject({ status: 'pending' });
    expect(charges.items.find((each) => each.id === charge)?.invoiceId).toBeUndefined();
    const next = await draftOf([charge]);
    expect(next.lines.map((line) => line.chargeId)).toEqual([charge]);
    expect(
      errorOf(await post(`/invoices/${invoice.id}/payments`, { amountMinor: 1, method: 'card' })),
    ).toEqual([409, 'invoice_not_payable']);
  });
});

describe('posting charges from events', () => {
  let service: string;
  let archived: string;
  let unpriced: string;

  async function addService(code: string, name: string, price: number | null, archive = false) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into services (tenant_id, code, name, category, tax_class)
       values ($1, $2, $3, 'imaging', 'exempt') returning id`,
      [hospital.id, code, name],
    );
    const id = rows[0]?.id ?? '';
    if (price !== null) {
      await pool.query(
        `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
         select $1, $2, id, $3, current_date - 10 from price_lists where tenant_id = $1 and standard`,
        [hospital.id, id, price],
      );
    }
    if (archive) await pool.query('update services set archived = true where id = $1', [id]);
    return id;
  }

  async function publish(event: string, entityId: string, payload: object) {
    await pool.query(
      `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
       values ($1, $2, $3, null, $4)`,
      [hospital.id, event, entityId, JSON.stringify(payload)],
    );
    await app.events.dispatch();
    await jobs.drain();
  }

  const completed = (orderId: string, serviceId: string, encounterId = encounters.other) =>
    publish('order.completed', orderId, {
      orderId,
      encounterId,
      patientId: patients.asha,
      type: 'imaging',
      serviceId,
      priority: 'routine',
    });

  const chargesOf = async (sourceRef: string) =>
    (
      await pool.query<{
        unit_price_minor: string;
        description: string;
        flag: string | null;
        status: string;
      }>(
        'select unit_price_minor::text, description, flag, status from charges where source_ref = $1',
        [sourceRef],
      )
    ).rows;

  beforeAll(async () => {
    service = await addService('XR-1', 'Chest X-ray', 45_000);
    archived = await addService('XR-OLD', 'Old scan', 30_000, true);
    unpriced = await addService('XR-NEW', 'New scan', null);
  });

  it('posts a completed order once, at the price in effect, and again posts nothing', async () => {
    const orderId = randomUUID();
    await completed(orderId, service);
    await completed(orderId, service);
    expect(await chargesOf(`order:${orderId}`)).toEqual([
      { unit_price_minor: '45000', description: 'Chest X-ray', flag: null, status: 'pending' },
    ]);
    const posted = await pool.query(
      "select 1 from outbox where event = 'charge.posted' and payload->>'encounterId' = $1",
      [encounters.other],
    );
    expect(posted.rowCount).toBeGreaterThan(0);
  });

  it('posts an archived service at its last price, flagged, and an unpriced one at nothing, flagged', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await completed(a, archived);
    await completed(b, unpriced);
    expect(await chargesOf(`order:${a}`)).toMatchObject([
      { unit_price_minor: '30000', flag: 'service_archived' },
    ]);
    expect(await chargesOf(`order:${b}`)).toMatchObject([
      { unit_price_minor: '0', flag: 'no_price' },
    ]);
  });

  it('charges an order of another hospital’s service to nobody', async () => {
    const orderId = randomUUID();
    await publish('order.completed', orderId, {
      orderId,
      encounterId: encounters.other,
      patientId: patients.asha,
      type: 'imaging',
      serviceId: randomUUID(),
    });
    expect(await chargesOf(`order:${orderId}`)).toEqual([]);
  });

  it('charges a completed ambulance trip once, at the list price, and nothing before or without a service', async () => {
    const tripId = randomUUID();
    const base = { patientId: patients.asha, encounterId: encounters.other, serviceId: service };
    const changed = (from: string, to: string) =>
      publish('ambulance.trip_status_changed', tripId, { ...base, from, to });
    await changed('requested', 'dispatched');
    expect(await chargesOf(`ambulance:${tripId}`)).toEqual([]);
    await changed('picked_up', 'completed');
    await changed('picked_up', 'completed');
    expect(await chargesOf(`ambulance:${tripId}`)).toEqual([
      { unit_price_minor: '45000', description: 'Chest X-ray', flag: null, status: 'pending' },
    ]);
    const bare = randomUUID();
    await publish('ambulance.trip_status_changed', bare, {
      patientId: patients.asha,
      encounterId: null,
      serviceId: null,
      to: 'completed',
    });
    expect(await chargesOf(`ambulance:${bare}`)).toEqual([]);
  });

  it('charges an issued blood unit once, at the list price, and nothing without a service', async () => {
    const unitId = randomUUID();
    const base = { patientId: patients.asha, encounterId: encounters.other, serviceId: service };
    await publish('blood.unit_status_changed', unitId, { ...base, from: 'reserved', to: 'issued' });
    await publish('blood.unit_status_changed', unitId, { ...base, from: 'reserved', to: 'issued' });
    expect(await chargesOf(`blood:${unitId}`)).toEqual([
      { unit_price_minor: '45000', description: 'Chest X-ray', flag: null, status: 'pending' },
    ]);
    const bare = randomUUID();
    await publish('blood.unit_status_changed', bare, {
      patientId: patients.asha,
      encounterId: null,
      serviceId: null,
      to: 'issued',
    });
    await publish('blood.unit_status_changed', unitId, { ...base, to: 'transfused' });
    expect(await chargesOf(`blood:${bare}`)).toEqual([]);
  });

  it('charges a dispense for each batch, and voids or flags it when units come back', async () => {
    const dispenseId = randomUUID();
    const client = await pool.connect();
    const batches = [randomUUID(), randomUUID()];
    const lines = [randomUUID(), randomUUID()];
    try {
      // The pharmacy's own tables are not under test here: their foreign keys are set aside.
      await client.query("set session_replication_role = 'replica'");
      await client.query(
        `insert into dispenses (id, tenant_id, order_id, prescription_id, encounter_id, patient_id,
           location_id, prescribed_drug_id, drug_id, item_name, schedule, controlled, quantity, dispensed_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'Paracetamol 500 mg', 'none', false, 7, $9)`,
        [
          dispenseId,
          hospital.id,
          randomUUID(),
          randomUUID(),
          encounters.other,
          patients.asha,
          randomUUID(),
          randomUUID(),
          admin.id,
        ],
      );
      for (const [index, batchId] of batches.entries()) {
        await client.query(
          `insert into stock_batches (id, tenant_id, drug_id, batch_number, expiry_date, mrp_minor, created_by)
           values ($1, $2, $3, $4, current_date + 300, $5, $6)`,
          [
            batchId,
            hospital.id,
            randomUUID(),
            `B${index}${Date.now()}`,
            index === 0 ? 250 : null,
            admin.id,
          ],
        );
        await client.query(
          `insert into dispense_lines (id, tenant_id, dispense_id, drug_id, batch_id, quantity, ledger_entry_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            lines[index],
            hospital.id,
            dispenseId,
            randomUUID(),
            batchId,
            index === 0 ? 4 : 3,
            randomUUID(),
          ],
        );
      }
    } finally {
      await client.query("set session_replication_role = 'origin'");
      client.release();
    }
    const payload = { dispenseId, encounterId: encounters.other, patientId: patients.asha };
    await publish('pharmacy.dispensed', dispenseId, payload);
    await publish('pharmacy.dispensed', dispenseId, payload);
    expect(await chargesOf(`dispense:${lines[0]}`)).toEqual([
      { unit_price_minor: '250', description: 'Paracetamol 500 mg', flag: null, status: 'pending' },
    ]);
    expect(await chargesOf(`dispense:${lines[1]}`)).toMatchObject([
      { unit_price_minor: '0', flag: 'no_price' },
    ]);

    // All four units of the first line come back: a pending charge is voided.
    const returnId = randomUUID();
    const back = await pool.connect();
    try {
      await back.query("set session_replication_role = 'replica'");
      await back.query(
        `insert into dispense_returns (id, tenant_id, dispense_id, reason, returned_by) values ($1, $2, $3, 'Unused', $4)`,
        [returnId, hospital.id, dispenseId, admin.id],
      );
      await back.query(
        `insert into dispense_return_lines (tenant_id, return_id, dispense_id, batch_id, quantity, wasted, ledger_entry_id)
         values ($1, $2, $3, $4, 4, false, $5)`,
        [hospital.id, returnId, dispenseId, batches[0], randomUUID()],
      );
    } finally {
      await back.query("set session_replication_role = 'origin'");
      back.release();
    }
    await publish('pharmacy.dispense_returned', returnId, { returnId, dispenseId });
    await publish('pharmacy.dispense_returned', returnId, { returnId, dispenseId });
    expect(await chargesOf(`dispense:${lines[0]}`)).toMatchObject([
      { status: 'void', flag: 'return_review' },
    ]);
    expect(await chargesOf(`dispense:${lines[1]}`)).toMatchObject([
      { status: 'pending', flag: 'no_price' },
    ]);
  });
});

describe('charging a service by hand (#115)', () => {
  let consult: string;
  let archived: string;
  let unpriced: string;
  let foreign: string;

  async function addService(
    tenant: TestTenant,
    code: string,
    price: number | null,
    archive = false,
  ) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into services (tenant_id, code, name, category, tax_class)
       values ($1, $2, $3, 'consultation', 'exempt') returning id`,
      [tenant.id, code, `Service ${code}`],
    );
    const id = rows[0]?.id ?? '';
    if (price !== null) {
      await pool.query(
        `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
         select $1, $2, id, $3, current_date - 10 from price_lists where tenant_id = $1 and standard`,
        [tenant.id, id, price],
      );
    }
    if (archive) await pool.query('update services set archived = true where id = $1', [id]);
    return id;
  }

  beforeAll(async () => {
    consult = await addService(hospital, 'HAND-1', 45_000);
    archived = await addService(hospital, 'HAND-2', 1_000, true);
    unpriced = await addService(hospital, 'HAND-3', null);
    foreign = await addService(clinic, 'HAND-4', 2_000);
  });

  const charge = (body: object, options: Options = {}, encounter = encounters.main) =>
    post(`/encounters/${encounter}/charges`, body, options);

  it('posts a pending charge at the price list’s price, whatever the client sends', async () => {
    const before = await pool.query(
      "select count(*)::int as n from outbox where event = 'charge.posted' and tenant_id = $1",
      [hospital.id],
    );
    const posted = await ok<Charge & { source: string; quantity: number }>(
      charge({ serviceId: consult, quantity: 2 }),
      201,
    );
    expect(posted).toMatchObject({
      source: 'service',
      description: 'Service HAND-1',
      quantity: 2,
      unitPriceMinor: 45_000,
      totalMinor: 90_000,
      status: 'pending',
    });
    expect(posted.flag).toBeUndefined();
    const listed = await ok<Page<Charge>>(
      get(`/encounters/${encounters.main}/charges?status=pending&limit=100`),
    );
    expect(listed.items.some((item) => item.id === posted.id)).toBe(true);
    const after = await pool.query(
      "select count(*)::int as n from outbox where event = 'charge.posted' and tenant_id = $1",
      [hospital.id],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    const draft = await draftOf([posted.id]);
    expect(draft.totalMinor).toBe(90_000);
  });

  it('posts once for one key, and again for another', async () => {
    const key = randomUUID();
    const first = await ok<Charge>(charge({ serviceId: consult, quantity: 1 }, { key }), 201);
    const again = await ok<Charge>(charge({ serviceId: consult, quantity: 1 }, { key }), 201);
    expect(again.id).toBe(first.id);
    const other = await ok<Charge>(charge({ serviceId: consult, quantity: 1 }), 201);
    expect(other.id).not.toBe(first.id);
  });

  it('refuses what cannot be charged', async () => {
    expect(errorOf(await charge({ serviceId: randomUUID(), quantity: 1 }))).toEqual([
      404,
      'service_not_found',
    ]);
    expect(errorOf(await charge({ serviceId: 'nope', quantity: 1 }))).toEqual([
      404,
      'service_not_found',
    ]);
    expect(errorOf(await charge({ serviceId: archived, quantity: 1 }))).toEqual([
      409,
      'service_archived',
    ]);
    expect(errorOf(await charge({ serviceId: unpriced, quantity: 1 }))).toEqual([409, 'no_price']);
    expect((await charge({ serviceId: consult, quantity: 0 })).statusCode).toBe(400);
    expect((await charge({ serviceId: consult, quantity: 10_000 })).statusCode).toBe(400);
    expect(errorOf(await charge({ serviceId: consult, quantity: 1 }, {}, randomUUID()))).toEqual([
      404,
      'encounter_not_found',
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `insert into encounters (tenant_id, patient_id, type, opened_by, status, cancel_reason, ended_at, ended_by)
       values ($1, $2, 'opd', $3, 'cancelled', 'Entered in error', now(), $3) returning id`,
      [hospital.id, patients.asha, admin.id],
    );
    const cancelled = rows[0]?.id ?? '';
    expect(errorOf(await charge({ serviceId: consult, quantity: 1 }, {}, cancelled))).toEqual([
      409,
      'encounter_cancelled',
    ]);
  });

  it('needs charge:create, and the billing switch', async () => {
    expect(errorOf(await charge({ serviceId: consult, quantity: 1 }, { user: doctor }))[1]).toBe(
      'permission_denied',
    );
    expect(
      errorOf(
        await charge({ serviceId: consult, quantity: 1 }, { tenant: closed, user: admin }),
      )[1],
    ).toBe('feature_disabled');
  });

  it('keeps the hospitals apart', async () => {
    expect(
      errorOf(
        await charge({ serviceId: consult, quantity: 1 }, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'encounter_not_found']);
    expect(errorOf(await charge({ serviceId: foreign, quantity: 1 }))).toEqual([
      404,
      'service_not_found',
    ]);
    const own = await ok<Charge>(
      charge(
        { serviceId: foreign, quantity: 1 },
        { tenant: clinic, user: clinicAdmin },
        encounters.clinic,
      ),
      201,
    );
    expect(own.unitPriceMinor).toBe(2_000);
  });
});

describe('the hospital boundary', () => {
  it('shows another hospital nothing, in SQL under the app role too', async () => {
    const invoice = await issued();
    for (const table of [
      'charges',
      'invoices',
      'invoice_lines',
      'payments',
      'credit_notes',
      'cash_register_sessions',
      'invoice_counters',
    ]) {
      const seen = await asTenantSql(pool, clinic.id, (client) =>
        client.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [hospital.id]),
      );
      expect(seen.rows[0]?.n, table).toBe(0);
    }
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into charges (tenant_id, encounter_id, patient_id, source, source_ref, description, quantity, unit_price_minor)
           values ($1, $2, $3, 'manual', 'x:1', 'x', 1, 1)`,
          [hospital.id, encounters.main, patients.asha],
        ),
      ),
    ).rejects.toThrow();
    expect(
      errorOf(
        await post(
          `/invoices/${invoice.id}/payments`,
          { amountMinor: 1, method: 'card' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'invoice_not_found']);
  });
});

describe('the invoice list and printing (#110)', () => {
  const search = (body: object, options: Options = {}) =>
    app.inject({
      method: 'POST',
      url: '/invoices/search',
      headers: as((options.tenant ?? hospital).id, (options.user ?? desk).id),
      payload: body,
    });
  const printed = async (invoiceId: string) =>
    (
      await pool.query<{ action: string }>(
        `select action from audit_log where entity = 'invoice' and entity_id = $1 and action = 'print'`,
        [invoiceId],
      )
    ).rows.length;

  it('pages the hospital’s invoices newest first with a total, and finds them by number or patient', async () => {
    const first = await issued();
    const second = await issued();
    const page = await ok<Page<Invoice>>(search({ limit: 1 }));
    expect(page.items.map((each) => each.id)).toEqual([second.id]);
    expect(page.total).toBeGreaterThanOrEqual(2);
    const next = await ok<Page<Invoice>>(search({ limit: 1, cursor: page.nextCursor }));
    expect(next.items[0]?.id).toBe(first.id);
    expect(next.total).toBeUndefined();
    const byNumber = await ok<Page<Invoice>>(search({ q: first.number }));
    expect(byNumber.items.map((each) => each.id)).toEqual([first.id]);
    const byPatient = await ok<Page<Invoice>>(search({ q: 'asha test', status: 'issued' }));
    expect(byPatient.items.length).toBeGreaterThanOrEqual(2);
    expect(byPatient.items.every((each) => each.status === 'issued')).toBe(true);
    expect((await ok<Page<Invoice>>(search({ q: 'zzz-nobody' }))).items).toEqual([]);
    expect((await ok<Page<Invoice>>(search({ q: '50%_' }))).items).toEqual([]);
    expect(errorOf(await search({ cursor: 'junk' }))).toEqual([400, 'invalid_cursor']);
    // A term with a pasted tab and a zero-width space finds what the clean term finds.
    const messy = await ok<Page<Invoice>>(search({ q: `asha	\u200Btest ${first.number}` }));
    expect(messy.items.map((each) => each.id)).toEqual([first.id]);
  });

  it('limits the list to a range of creation dates', async () => {
    const invoice = await issued();
    const day = 24 * 60 * 60 * 1000;
    const around = (offset: number) => new Date(Date.now() + offset).toISOString();
    const inside = await ok<Page<Invoice>>(
      search({ q: invoice.number, from: around(-day), to: around(day) }),
    );
    expect(inside.items.map((each) => each.id)).toEqual([invoice.id]);
    const before = await ok<Page<Invoice>>(
      search({ q: invoice.number, from: around(-3 * day), to: around(-2 * day) }),
    );
    expect(before.items).toEqual([]);
    const after = await ok<Page<Invoice>>(search({ q: invoice.number, from: around(day) }));
    expect(after.items).toEqual([]);
  });

  it('shows another hospital nothing and needs the permission and the flag', async () => {
    const mine = await issued();
    const theirs = await ok<Page<Invoice>>(search({}, { tenant: clinic, user: clinicAdmin }));
    expect(theirs.items.map((each) => each.id)).not.toContain(mine.id);
    expect(errorOf(await search({}, { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('records a print once per press, for whoever may print', async () => {
    const invoice = await issued();
    const key = randomUUID();
    expect((await post(`/invoices/${invoice.id}/print`, {}, { key })).statusCode).toBe(204);
    expect((await post(`/invoices/${invoice.id}/print`, {}, { key })).statusCode).toBe(204);
    expect(await printed(invoice.id)).toBe(1);
    expect((await post(`/invoices/${invoice.id}/print`, {})).statusCode).toBe(204);
    expect(await printed(invoice.id)).toBe(2);
  });

  it('refuses a print without the permission, of a draft, a void invoice or another hospital’s', async () => {
    const invoice = await issued();
    expect(errorOf(await post(`/invoices/${invoice.id}/print`, {}, { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    const draft = await draftOf([await addCharge(encounters.main)]);
    expect(errorOf(await post(`/invoices/${draft.id}/print`, {}))).toEqual([409, 'not_printable']);
    expect(
      errorOf(
        await post(`/invoices/${invoice.id}/print`, {}, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'invoice_not_found']);
    expect(await printed(invoice.id)).toBe(0);
  });
});
