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

/**
 * Counter sales, their returns and the drug register through the real app and database (#101):
 * over-the-counter items to anyone, scheduled items only against an outside prescription to a
 * registered patient, stock moving once through the ledger, returns never more than was sold,
 * every movement of a register item in the register, the hospital boundary, permissions and audit.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Pharmacy switched off. */
let closed: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let pharmacist: TestUser;
let clinicPharmacist: TestUser;
const patients = { asha: '', clinic: '' };
const drugs = { otc: '', bandage: '', h: '', h1: '', narcotic: '', noPrice: '', clinicOtc: '' };
const places = { pharmacy: '', clinic: '' };

interface SaleLine {
  id: string;
  drugId: string;
  batchId: string;
  quantity: number;
  returnedQuantity: number;
  unitPriceMinor: string;
}
interface Sale {
  id: string;
  patientId?: string;
  patientName?: string;
  prescriberName?: string;
  totalMinor: string;
  returnedMinor: string;
  lines: SaleLine[];
  returns: { id: string; reason: string; totalMinor: string; lines: unknown[] }[];
}
interface RegisterEntry {
  id: string;
  source: string;
  sourceId: string;
  quantity: number;
  balanceAfter: number;
  patientName?: string;
  prescriberName?: string;
  prescriberRegistration?: string;
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
  app.inject({
    url,
    headers: as((options.tenant ?? hospital).id, (options.user ?? pharmacist).id),
  });
const post = (url: string, body?: object, options: Options = {}) => {
  const { tenant = hospital, user = pharmacist, key = randomUUID() } = options;
  return app.inject({
    method: 'POST',
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    ...(body === undefined ? {} : { payload: body }),
  });
};
const errorOf = (response: Reply) => [response.statusCode, response.json().error.code];

async function ok<T>(response: Promise<Reply> | Reply, status = 200): Promise<T> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode} ${reply.body}`);
  }
  return reply.json<T>();
}

/** A calendar date `days` from today, in UTC: far enough from the edges for these tests. */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const tenants = () => [hospital.id, clinic.id, closed.id];

let mrn = 0;
async function addPatient(tenant: TestTenant, first: string) {
  mrn += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Test', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `PS-${String(mrn).padStart(7, '0')}`, first],
  );
  return rows[0]?.id ?? '';
}

async function addDoctor(tenant: TestTenant, user: TestUser) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, 'General'],
  );
  await pool.query(
    `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
     values ($1, $2, $3, 'General', 15)`,
    [tenant.id, user.id, rows[0]?.id],
  );
}

async function addDrug(
  tenant: TestTenant,
  generic: string,
  { type = 'medicine', schedule = 'none', controlled = false } = {},
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into drugs (tenant_id, type, generic_name, form, strength, unit, schedule, controlled, tax_class)
     values ($1, $2, $3, 'tablet', '10 mg', 'tablet', $4, $5, 'standard') returning id`,
    [tenant.id, type, generic, schedule, controlled],
  );
  return rows[0]?.id ?? '';
}

async function addPlace(tenant: TestTenant, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into stock_locations (tenant_id, name, kind) values ($1, $2, 'pharmacy') returning id",
    [tenant.id, name],
  );
  return rows[0]?.id ?? '';
}

let batchCount = 0;
/** A new batch with stock at a place, posted to the ledger as opening stock. */
async function addStock(
  drugId: string,
  quantity: number,
  {
    locationId = places.pharmacy,
    expiryDays = 400,
    tenant = hospital,
    mrp = 250 as number | null,
  } = {},
) {
  batchCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into stock_batches (tenant_id, drug_id, batch_number, expiry_date, mrp_minor, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tenant.id, drugId, `SB${String(batchCount).padStart(4, '0')}`, day(expiryDays), mrp, admin.id],
  );
  const batchId = rows[0]?.id ?? '';
  await pool.query(
    `insert into stock_ledger (tenant_id, batch_id, drug_id, location_id, quantity, source, source_id, reason, actor_id)
     values ($1, $2, $3, $4, $5, 'adjustment', $6, 'opening', $7)`,
    [tenant.id, batchId, drugId, locationId, quantity, randomUUID(), admin.id],
  );
  return batchId;
}

const onHand = async (batchId: string, locationId = places.pharmacy) =>
  (
    await pool.query<{ on_hand: number }>(
      'select on_hand from stock_balances where batch_id = $1 and location_id = $2',
      [batchId, locationId],
    )
  ).rows[0]?.on_hand ?? 0;

const outsideRx = {
  prescriberName: 'Dr Mehta',
  prescriberRegistration: 'MCI-12345',
  prescribedOn: day(-1),
};

const sell = (
  lines: { drugId: string; batches: { batchId: string; quantity: number }[] }[],
  extra: object = {},
  options: Options = {},
) => post('/pharmacy/sales', { locationId: places.pharmacy, lines, ...extra }, options);

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      `select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at`,
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

const register = (drugId: string, options: Options = {}, query = '') =>
  get(`/pharmacy/register?drugId=${drugId}&from=${day(-1)}&to=${day(1)}${query}`, options);

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { patients: true, drugs: true, clinical: true, inventory: true, pharmacy: true };
  hospital = await createTenant(pool, 'Sales Hospital', { features });
  clinic = await createTenant(pool, 'Sales Clinic', { features });
  closed = await createTenant(pool, 'Sales Closed', { features: { ...features, pharmacy: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Sales Admin');
  doctor = await user('Sales Doctor');
  pharmacist = await user('Sales Pharmacist');
  clinicPharmacist = await user('Sales Clinic Pharmacist');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, pharmacist, closed, 'pharmacist');
  await addMembership(pool, clinicPharmacist, clinic, 'pharmacist');
  await addDoctor(hospital, doctor);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.clinic = await addPatient(clinic, 'Dina');
  drugs.otc = await addDrug(hospital, 'Cetirizine');
  drugs.bandage = await addDrug(hospital, 'Bandage', { type: 'consumable' });
  drugs.h = await addDrug(hospital, 'Amoxicillin', { schedule: 'h' });
  drugs.h1 = await addDrug(hospital, 'Alprazolam', { schedule: 'h1' });
  drugs.narcotic = await addDrug(hospital, 'Tramadol', { schedule: 'narcotic', controlled: true });
  drugs.noPrice = await addDrug(hospital, 'Vitamin C');
  drugs.clinicOtc = await addDrug(clinic, 'Cetirizine');
  places.pharmacy = await addPlace(hospital, 'Pharmacy counter');
  places.clinic = await addPlace(clinic, 'Clinic counter');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Sales, dispenses, the ledger and the balances refuse removal to everyone: triggers are off.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'pharmacy_sale_return_lines',
      'pharmacy_sale_returns',
      'pharmacy_sale_lines',
      'pharmacy_sales',
      'dispense_lines',
      'dispenses',
      'stock_ledger',
      'stock_balances',
      'stock_batches',
      'stock_locations',
      'orders',
      'prescriptions',
      'encounters',
      'outbox',
      'drugs',
      'doctors',
      'departments',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, doctor, pharmacist, clinicPharmacist]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('selling', () => {
  it('sells over-the-counter items to anyone at each batch’s price, once on a repeat', async () => {
    const first = await addStock(drugs.otc, 3, { expiryDays: 100, mrp: 250 });
    const second = await addStock(drugs.otc, 10, { mrp: 300 });
    const bandage = await addStock(drugs.bandage, 5, { mrp: 1000 });
    const key = randomUUID();
    const lines = [
      {
        drugId: drugs.otc,
        batches: [
          { batchId: first, quantity: 3 },
          { batchId: second, quantity: 1 },
        ],
      },
      { drugId: drugs.bandage, batches: [{ batchId: bandage, quantity: 2 }] },
    ];
    const sale = await ok<Sale>(sell(lines, {}, { key }), 201);
    expect(sale.patientId).toBeUndefined();
    expect(sale.lines).toHaveLength(3);
    expect(sale.totalMinor).toBe(String(3 * 250 + 300 + 2 * 1000));
    expect(await onHand(first)).toBe(0);
    expect(await onHand(second)).toBe(9);
    expect(await onHand(bandage)).toBe(3);
    expect(await audited('pharmacy_sale', sale.id)).toContain('create');
    expect((await events(sale.id)).map((each) => each.event)).toEqual(['pharmacy.sold']);

    const again = await ok<Sale>(sell(lines, {}, { key }), 201);
    expect(again.id).toBe(sale.id);
    expect(await onHand(second)).toBe(9);

    const list = await ok<Page<{ id: string; totalMinor: string }>>(get('/pharmacy/sales'));
    expect(list.items.find((each) => each.id === sale.id)?.totalMinor).toBe(sale.totalMinor);
  });

  it('sells a scheduled item only against a prescription to a registered patient', async () => {
    const batch = await addStock(drugs.h, 10);
    const lines = [{ drugId: drugs.h, batches: [{ batchId: batch, quantity: 2 }] }];
    expect(errorOf(await sell(lines))).toEqual([422, 'prescription_required']);
    expect(errorOf(await sell(lines, { patientId: patients.asha }))).toEqual([
      422,
      'prescription_required',
    ]);
    expect(errorOf(await sell(lines, outsideRx))).toEqual([422, 'prescription_required']);
    expect(
      errorOf(await sell(lines, { patientId: patients.asha, prescriberName: 'Dr Mehta' })),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await sell(lines, { patientId: patients.asha, ...outsideRx, prescribedOn: day(5) })),
    ).toEqual([400, 'validation_failed']);
    // Another hospital's patient is no patient here.
    expect(errorOf(await sell(lines, { patientId: patients.clinic, ...outsideRx }))).toEqual([
      422,
      'unknown_patient',
    ]);
    expect(await onHand(batch)).toBe(10);

    const sale = await ok<Sale>(sell(lines, { patientId: patients.asha, ...outsideRx }), 201);
    expect(sale.patientName).toBe('Asha Test');
    expect(sale.prescriberName).toBe('Dr Mehta');
    expect(await onHand(batch)).toBe(8);
  });

  it('refuses a batch with no price, too much, an expired batch and an item twice', async () => {
    const noPrice = await addStock(drugs.noPrice, 5, { mrp: null });
    expect(
      errorOf(
        await sell([{ drugId: drugs.noPrice, batches: [{ batchId: noPrice, quantity: 1 }] }]),
      ),
    ).toEqual([409, 'no_price']);
    expect(await onHand(noPrice)).toBe(5);
    const few = await addStock(drugs.otc, 1);
    expect(
      errorOf(await sell([{ drugId: drugs.otc, batches: [{ batchId: few, quantity: 2 }] }])),
    ).toEqual([409, 'insufficient_stock']);
    const expired = await addStock(drugs.otc, 5, { expiryDays: -3 });
    expect(
      errorOf(await sell([{ drugId: drugs.otc, batches: [{ batchId: expired, quantity: 1 }] }])),
    ).toEqual([409, 'batch_expired']);
    const line = { drugId: drugs.otc, batches: [{ batchId: few, quantity: 1 }] };
    expect(errorOf(await sell([line, line]))).toEqual([422, 'unknown_item']);
    expect(
      errorOf(await sell([{ drugId: drugs.clinicOtc, batches: [{ batchId: few, quantity: 1 }] }])),
    ).toEqual([422, 'unknown_item']);
  });

  it('offers an item’s batches with their prices and what it needs', async () => {
    await addStock(drugs.narcotic, 4);
    const options = await ok<{
      needsPrescription: boolean;
      inRegister: boolean;
      batches: { mrpMinor?: string }[];
    }>(get(`/pharmacy/sale-options?drugId=${drugs.narcotic}&locationId=${places.pharmacy}`));
    expect(options.needsPrescription).toBe(true);
    expect(options.inRegister).toBe(true);
    expect(options.batches[0]?.mrpMinor).toBe('250');
    const otc = await ok<{ needsPrescription: boolean; inRegister: boolean }>(
      get(`/pharmacy/sale-options?drugId=${drugs.otc}&locationId=${places.pharmacy}`),
    );
    expect([otc.needsPrescription, otc.inRegister]).toEqual([false, false]);
  });
});

describe('returns', () => {
  it('brings units back into stock, never more than were sold', async () => {
    const batch = await addStock(drugs.otc, 10, { mrp: 100 });
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 4 }] }]),
      201,
    );
    const line = sale.lines[0];
    if (!line) throw new Error('no line');
    const key = randomUUID();
    const body = { reason: 'Not needed', lines: [{ saleLineId: line.id, quantity: 3 }] };
    const back = await ok<Sale>(post(`/pharmacy/sales/${sale.id}/returns`, body, { key }), 201);
    expect(back.lines[0]?.returnedQuantity).toBe(3);
    expect(back.returnedMinor).toBe('300');
    expect(back.returns).toHaveLength(1);
    expect(await onHand(batch)).toBe(9);
    // A repeat moves nothing.
    await ok<Sale>(post(`/pharmacy/sales/${sale.id}/returns`, body, { key }), 201);
    expect(await onHand(batch)).toBe(9);
    expect(
      errorOf(
        await post(`/pharmacy/sales/${sale.id}/returns`, {
          reason: 'More',
          lines: [{ saleLineId: line.id, quantity: 2 }],
        }),
      ),
    ).toEqual([409, 'over_return']);
    expect(
      errorOf(
        await post(`/pharmacy/sales/${sale.id}/returns`, {
          reason: 'Other',
          lines: [{ saleLineId: randomUUID(), quantity: 1 }],
        }),
      ),
    ).toEqual([422, 'unknown_line']);
    expect((await events(back.returns[0]?.id ?? '')).map((each) => each.event)).toEqual([
      'pharmacy.sale_returned',
    ]);
  });

  it('two returns of the last unit at once: one taken back', async () => {
    const batch = await addStock(drugs.otc, 5);
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }]),
      201,
    );
    const body = { reason: 'Back', lines: [{ saleLineId: sale.lines[0]?.id, quantity: 1 }] };
    const replies = await Promise.all([
      post(`/pharmacy/sales/${sale.id}/returns`, body),
      post(`/pharmacy/sales/${sale.id}/returns`, body),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    expect(await onHand(batch)).toBe(5);
  });
});

describe('the drug register', () => {
  it('holds every sale, return and dispense of a register item, with who and who prescribed', async () => {
    const batch = await addStock(drugs.h1, 20);
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.h1, batches: [{ batchId: batch, quantity: 2 }] }], {
        patientId: patients.asha,
        ...outsideRx,
      }),
      201,
    );
    await ok<Sale>(
      post(`/pharmacy/sales/${sale.id}/returns`, {
        reason: 'Wrong strength',
        lines: [{ saleLineId: sale.lines[0]?.id, quantity: 1 }],
      }),
      201,
    );
    // A dispense against an in-hospital prescription.
    const encounter = await ok<{ id: string }>(
      post('/encounters', { patientId: patients.asha }, { user: doctor }),
      201,
    );
    const rx = await ok<{ id: string }>(
      post(
        `/encounters/${encounter.id}/prescriptions`,
        {
          lines: [
            { drugId: drugs.h1, dose: '1 tablet', route: 'oral', frequency: '0-0-1', quantity: 3 },
          ],
        },
        { user: doctor },
      ),
      201,
    );
    const line = (
      await ok<{ lines: { orderId: string; version: number; dispensedQuantity: number }[] }>(
        get(`/pharmacy/prescriptions/${rx.id}`),
      )
    ).lines[0];
    if (!line) throw new Error('no line');
    const dispensed = await ok<{ id: string }>(
      post('/pharmacy/dispenses', {
        orderId: line.orderId,
        expectedVersion: line.version,
        expectedDispensedQuantity: line.dispensedQuantity,
        locationId: places.pharmacy,
        batches: [{ batchId: batch, quantity: 3 }],
      }),
      201,
    );

    const page = await ok<Page<RegisterEntry>>(register(drugs.h1));
    expect(page.items.map((each) => [each.source, each.quantity, each.balanceAfter])).toEqual([
      ['adjustment', 20, 20],
      ['sale', -2, 18],
      ['sale_return', 1, 19],
      ['dispense', -3, 16],
    ]);
    expect(page.total).toBe(4);
    const [, sold, returned, given] = page.items;
    expect(sold?.patientName).toBe('Asha Test');
    expect(sold?.prescriberRegistration).toBe('MCI-12345');
    expect(returned?.patientName).toBe('Asha Test');
    expect(given?.prescriberName).toBe('Sales Doctor');
    expect(given?.sourceId).toBe(dispensed.id);
    expect(await audited('pharmacy_sale', sale.id)).toContain('read');
    expect(await audited('dispense', dispensed.id)).toContain('read');

    // Paged by cursor, the oldest first.
    const one = await ok<Page<RegisterEntry>>(register(drugs.h1, {}, '&limit=3'));
    const rest = await ok<Page<RegisterEntry>>(
      register(drugs.h1, {}, `&limit=3&cursor=${one.nextCursor ?? ''}`),
    );
    expect(rest.items.map((each) => each.source)).toEqual(['dispense']);
    expect(errorOf(await register(drugs.h1, {}, '&cursor=forged'))).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('is only of register items, within a year', async () => {
    expect(errorOf(await register(drugs.otc))).toEqual([422, 'not_a_register_item']);
    expect(errorOf(await register(drugs.h))).toEqual([422, 'not_a_register_item']);
    expect(errorOf(await register(randomUUID()))).toEqual([404, 'item_not_found']);
    expect(
      errorOf(await get(`/pharmacy/register?drugId=${drugs.h1}&from=${day(1)}&to=${day(-1)}`)),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await get(`/pharmacy/register?drugId=${drugs.h1}&from=${day(-400)}&to=${day(0)}`)),
    ).toEqual([400, 'validation_failed']);
    await ok<Page<RegisterEntry>>(register(drugs.narcotic));
  });
});

describe('access', () => {
  it('needs the permissions and the pharmacy switch', async () => {
    expect(errorOf(await get('/pharmacy/sales', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await register(drugs.h1, { user: doctor }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await get('/pharmacy/sales', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('keeps each hospital to its own sales and returns', async () => {
    const batch = await addStock(drugs.otc, 5);
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }]),
      201,
    );
    const other = { tenant: clinic, user: clinicPharmacist };
    expect(errorOf(await get(`/pharmacy/sales/${sale.id}`, other))).toEqual([
      404,
      'sale_not_found',
    ]);
    expect(
      errorOf(
        await post(
          `/pharmacy/sales/${sale.id}/returns`,
          { reason: 'x', lines: [{ saleLineId: sale.lines[0]?.id, quantity: 1 }] },
          other,
        ),
      ),
    ).toEqual([404, 'sale_not_found']);
    expect(errorOf(await post(`/pharmacy/sales/${sale.id}/print`, undefined, other))).toEqual([
      404,
      'sale_not_found',
    ]);
    // The clinic cannot sell the hospital's batch from its own counter.
    expect(
      errorOf(
        await sell(
          [{ drugId: drugs.clinicOtc, batches: [{ batchId: batch, quantity: 1 }] }],
          { locationId: places.clinic },
          other,
        ),
      ),
    ).toEqual([422, 'unknown_batch']);
    const list = await ok<Page<{ id: string }>>(get('/pharmacy/sales?limit=100', other));
    expect(list.items.some((each) => each.id === sale.id)).toBe(false);
    const seen = await asTenantSql(pool, clinic.id, async (client) => [
      (await client.query('select id from pharmacy_sales where id = $1', [sale.id])).rowCount,
      (await client.query('select id from pharmacy_sale_lines where sale_id = $1', [sale.id]))
        .rowCount,
      (await client.query('select id from pharmacy_sale_returns where sale_id = $1', [sale.id]))
        .rowCount,
      (
        await client.query('select id from pharmacy_sale_return_lines where sale_id = $1', [
          sale.id,
        ])
      ).rowCount,
    ]);
    expect(seen).toEqual([0, 0, 0, 0]);
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into pharmacy_sales (tenant_id, location_id, total_minor, sold_by)
           values ($1, $2, 0, $3)`,
          [hospital.id, places.pharmacy, pharmacist.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('records a printed receipt, and never changes a sale', async () => {
    const batch = await addStock(drugs.otc, 5);
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }]),
      201,
    );
    const printed = await post(`/pharmacy/sales/${sale.id}/print`);
    expect(printed.statusCode).toBe(204);
    expect(await audited('pharmacy_sale', sale.id)).toContain('print');
    await expect(
      pool.query('update pharmacy_sales set total_minor = 0 where id = $1', [sale.id]),
    ).rejects.toThrow(/never changed/);
    await expect(
      pool.query('delete from pharmacy_sale_lines where sale_id = $1', [sale.id]),
    ).rejects.toThrow(/never changed/);
  });
});

describe('limits and races', () => {
  it('sells the most a sale holds: 11 items of 10 batches, 110 lines', async () => {
    const lines = [];
    for (let item = 0; item < 11; item += 1) {
      const drugId = await addDrug(hospital, `Bulk item ${item}`);
      const batches = [];
      for (let batch = 0; batch < 10; batch += 1) {
        batches.push({ batchId: await addStock(drugId, 1), quantity: 1 });
      }
      lines.push({ drugId, batches });
    }
    const sale = await ok<Sale>(sell(lines), 201);
    expect(sale.lines).toHaveLength(110);
    expect(sale.totalMinor).toBe(String(110 * 250));
  });

  it('refuses a date that does not exist with a 400, never a 500', async () => {
    const batch = await addStock(drugs.h, 2);
    expect(
      errorOf(
        await sell([{ drugId: drugs.h, batches: [{ batchId: batch, quantity: 1 }] }], {
          patientId: patients.asha,
          ...outsideRx,
          prescribedOn: '2026-02-30',
        }),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await get(`/pharmacy/register?drugId=${drugs.h1}&from=2026-02-30&to=2026-03-02`)),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await get(`/pharmacy/register?drugId=${drugs.h1}&from=2026-03-01&to=2026-02-31`)),
    ).toEqual([400, 'validation_failed']);
  });

  it('never oversells: two sales of the last unit at once, one sold', async () => {
    const batch = await addStock(drugs.otc, 1);
    const line = [{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }];
    const replies = await Promise.all([sell(line), sell(line)]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    expect(await onHand(batch)).toBe(0);
  });

  it('two carts of the same items in the other order at once both sell', async () => {
    const otc = await addStock(drugs.otc, 5);
    const bandage = await addStock(drugs.bandage, 5);
    const one = { drugId: drugs.otc, batches: [{ batchId: otc, quantity: 1 }] };
    const two = { drugId: drugs.bandage, batches: [{ batchId: bandage, quantity: 1 }] };
    const replies = await Promise.all([sell([one, two]), sell([two, one])]);
    expect(replies.map((reply) => reply.statusCode)).toEqual([201, 201]);
    expect([await onHand(otc), await onHand(bandage)]).toEqual([3, 3]);
  });
});

describe('roles', () => {
  async function withRole(
    roleId: string,
    grants: [string, string][],
    run: (user: TestUser) => Promise<void>,
  ) {
    await pool.query('insert into roles (tenant_id, id, name) values ($1, $2, $2)', [
      hospital.id,
      roleId,
    ]);
    for (const [permission, scope] of grants) {
      await pool.query(
        'insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, $2, $3, $4)',
        [hospital.id, roleId, permission, scope],
      );
    }
    const user = await createUser(pool, `User ${roleId}`, { withPassword: false });
    await addMembership(pool, user, hospital, roleId);
    try {
      await run(user);
    } finally {
      await deleteUsers(pool, [user]);
    }
  }

  it('refuses a named patient to a seller who may not read patients', async () => {
    await withRole(
      'sale_only',
      [
        ['sale:read', 'all'],
        ['sale:create', 'all'],
      ],
      async (user) => {
        const batch = await addStock(drugs.otc, 2);
        expect(
          errorOf(
            await sell(
              [{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }],
              { patientId: patients.asha },
              { user },
            ),
          ),
        ).toEqual([422, 'unknown_patient']);
        // A walk-in is still sold to.
        await ok<Sale>(
          sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }], {}, { user }),
          201,
        );
      },
    );
  });

  it('reaches nothing with a scope narrower than the whole hospital', async () => {
    const batch = await addStock(drugs.otc, 2);
    const sale = await ok<Sale>(
      sell([{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }]),
      201,
    );
    await withRole(
      'own_seller',
      [
        ['sale:read', 'own'],
        ['sale:create', 'own'],
        ['sale:return', 'own'],
        ['drugRegister:read', 'own'],
      ],
      async (user) => {
        const list = await ok<Page<{ id: string }>>(get('/pharmacy/sales', { user }));
        expect(list.items).toEqual([]);
        expect(errorOf(await get(`/pharmacy/sales/${sale.id}`, { user }))).toEqual([
          404,
          'sale_not_found',
        ]);
        expect(
          errorOf(
            await post(
              `/pharmacy/sales/${sale.id}/returns`,
              { reason: 'x', lines: [{ saleLineId: sale.lines[0]?.id, quantity: 1 }] },
              { user },
            ),
          ),
        ).toEqual([404, 'sale_not_found']);
        expect(
          errorOf(
            await sell(
              [{ drugId: drugs.otc, batches: [{ batchId: batch, quantity: 1 }] }],
              {},
              { user },
            ),
          ),
        ).toEqual([403, 'permission_denied']);
        const register = await ok<Page<unknown>>(
          get(`/pharmacy/register?drugId=${drugs.h1}&from=${day(-1)}&to=${day(1)}`, { user }),
        );
        expect(register.items).toEqual([]);
      },
    );
  });
});
