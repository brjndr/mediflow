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
 * The pharmacy API through the real app and database (#100): the queue, dispensing in full and in
 * part from batches nearest expiry first, generic substitution, stock moving exactly once on a
 * retry and never oversold, the hospital boundary, permissions, audit and events.
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
const drugs = { para: '', paraBrand: '', paraStrong: '', cetirizine: '', clinicPara: '' };
const places = { pharmacy: '', store: '', clinic: '' };

interface Line {
  orderId: string;
  version: number;
  status: string;
  quantity?: number;
  dispensedQuantity: number;
}
interface Prescription {
  prescriptionId: string;
  encounterId: string;
  patientName: string;
  lines: Line[];
  dispenses: Dispense[];
}
interface Dispense {
  id: string;
  orderId: string;
  drugId: string;
  itemName: string;
  quantity: number;
  substitutionReason?: string;
  batches: { batchId: string; batchNumber: string; quantity: number }[];
  dispensedByName: string;
}
interface QueueItem {
  prescriptionId: string;
  patientName: string;
  patientMrn: string;
  lineCount: number;
  openLineCount: number;
  startedLineCount: number;
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
    [tenant.id, `PH-${String(mrn).padStart(7, '0')}`, first],
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
  {
    brand = null,
    strength = '500 mg',
    reorderLevel = null,
  }: {
    brand?: string | null;
    strength?: string;
    reorderLevel?: number | null;
  } = {},
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into drugs (tenant_id, type, generic_name, brand_name, form, strength, unit, schedule, tax_class, reorder_level)
     values ($1, 'medicine', $2, $3, 'tablet', $4, 'tablet', 'none', 'standard', $5) returning id`,
    [tenant.id, generic, brand, strength, reorderLevel],
  );
  return rows[0]?.id ?? '';
}

async function addPlace(tenant: TestTenant, name: string, kind: string) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into stock_locations (tenant_id, name, kind) values ($1, $2, $3) returning id',
    [tenant.id, name, kind],
  );
  return rows[0]?.id ?? '';
}

let batchCount = 0;
/** A new batch with stock at a place, posted to the ledger as opening stock. */
async function stockIn(
  drugId: string,
  quantity: number,
  { locationId = places.pharmacy, expiryDays = 400, tenant = hospital } = {},
) {
  batchCount += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into stock_batches (tenant_id, drug_id, batch_number, expiry_date, created_by)
     values ($1, $2, $3, $4, $5) returning id`,
    [tenant.id, drugId, `PB${String(batchCount).padStart(4, '0')}`, day(expiryDays), admin.id],
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

/** A prescription of a new encounter, written by the doctor; its lines in order. */
async function prescribe(
  lines: { drugId: string; quantity?: number }[],
  { tenant = hospital }: { tenant?: TestTenant } = {},
) {
  const patientId = tenant === hospital ? patients.asha : patients.clinic;
  const encounter = await ok<{ id: string }>(
    post('/encounters', { patientId }, { tenant, user: doctor }),
    201,
  );
  return ok<{ id: string; lines: { id: string; version: number }[] }>(
    post(
      `/encounters/${encounter.id}/prescriptions`,
      {
        lines: lines.map((line) => ({
          drugId: line.drugId,
          dose: '1 tablet',
          route: 'oral',
          frequency: '1-0-1',
          ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
        })),
      },
      { tenant, user: doctor },
    ),
    201,
  );
}

const prescriptionOf = (id: string, options: Options = {}) =>
  ok<Prescription>(get(`/pharmacy/prescriptions/${id}`, options));
const lineOf = async (prescriptionId: string, index = 0) => {
  const line = (await prescriptionOf(prescriptionId)).lines[index];
  if (!line) throw new Error('no such line');
  return line;
};

const dispense = (
  line: { orderId: string; version: number; dispensedQuantity: number },
  batches: { batchId: string; quantity: number }[],
  extra: object = {},
  options: Options = {},
) =>
  post(
    '/pharmacy/dispenses',
    {
      orderId: line.orderId,
      expectedVersion: line.version,
      expectedDispensedQuantity: line.dispensedQuantity,
      locationId: places.pharmacy,
      batches,
      ...extra,
    },
    options,
  );

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

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { patients: true, drugs: true, clinical: true, inventory: true, pharmacy: true };
  hospital = await createTenant(pool, 'Pharmacy Hospital', { features });
  clinic = await createTenant(pool, 'Pharmacy Clinic', { features });
  closed = await createTenant(pool, 'Pharmacy Closed', {
    features: { ...features, pharmacy: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Pharmacy Admin');
  doctor = await user('Pharmacy Doctor');
  pharmacist = await user('Pharmacist');
  clinicPharmacist = await user('Clinic Pharmacist');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, doctor, closed, 'doctor');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, pharmacist, closed, 'pharmacist');
  await addMembership(pool, clinicPharmacist, clinic, 'pharmacist');
  for (const tenant of [hospital, clinic, closed]) await addDoctor(tenant, doctor);
  patients.asha = await addPatient(hospital, 'Asha');
  patients.clinic = await addPatient(clinic, 'Dina');
  drugs.para = await addDrug(hospital, 'Paracetamol', { reorderLevel: 5 });
  drugs.paraBrand = await addDrug(hospital, 'Paracetamol', { brand: 'Calpol' });
  drugs.paraStrong = await addDrug(hospital, 'Paracetamol', { strength: '650 mg' });
  drugs.cetirizine = await addDrug(hospital, 'Cetirizine', { strength: '10 mg' });
  drugs.clinicPara = await addDrug(clinic, 'Paracetamol');
  places.pharmacy = await addPlace(hospital, 'Pharmacy counter', 'pharmacy');
  places.store = await addPlace(hospital, 'Main store', 'store');
  places.clinic = await addPlace(clinic, 'Clinic counter', 'pharmacy');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Dispenses, the ledger and the balances refuse removal to everyone: the triggers are off.
    await client.query('set local session_replication_role = replica');
    for (const table of [
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

describe('the queue', () => {
  it('lists an open prescription with its patient and lines, audits it, then lists it done', async () => {
    const rx = await prescribe([
      { drugId: drugs.cetirizine, quantity: 2 },
      { drugId: drugs.cetirizine, quantity: 1 },
    ]);
    const batch = await stockIn(drugs.cetirizine, 10);
    const open = await ok<Page<QueueItem>>(get('/pharmacy/queue?limit=100'));
    expect(open.total).toBeGreaterThan(0);
    expect(open.items.find((each) => each.prescriptionId === rx.id)).toMatchObject({
      patientName: 'Asha Test',
      lineCount: 2,
      openLineCount: 2,
      startedLineCount: 0,
    });
    expect(await audited('prescription', rx.id)).toContain('read');

    const detail = await prescriptionOf(rx.id);
    for (const line of detail.lines) {
      await ok(dispense(line, [{ batchId: batch, quantity: line.quantity ?? 1 }]), 201);
    }
    const after = await ok<Page<QueueItem>>(get('/pharmacy/queue?limit=100'));
    expect(after.items.some((each) => each.prescriptionId === rx.id)).toBe(false);
    const done = await ok<Page<QueueItem>>(get('/pharmacy/queue?state=done&limit=100'));
    expect(done.items.find((each) => each.prescriptionId === rx.id)).toMatchObject({
      openLineCount: 0,
      startedLineCount: 2,
    });
  });

  it('pages by cursor and refuses a forged one', async () => {
    await prescribe([{ drugId: drugs.cetirizine }]);
    await prescribe([{ drugId: drugs.cetirizine }]);
    const first = await ok<Page<QueueItem>>(get('/pharmacy/queue?limit=1'));
    expect(first.nextCursor).not.toBeNull();
    const second = await ok<Page<QueueItem>>(
      get(`/pharmacy/queue?limit=1&cursor=${first.nextCursor ?? ''}`),
    );
    expect(second.total).toBeUndefined();
    expect(second.items[0]?.prescriptionId).not.toBe(first.items[0]?.prescriptionId);
    expect(errorOf(await get('/pharmacy/queue?cursor=bm9wZQ'))).toEqual([400, 'invalid_cursor']);
    // A cursor of the open list is not one of the done list.
    expect(
      errorOf(await get(`/pharmacy/queue?state=done&cursor=${first.nextCursor ?? ''}`)),
    ).toEqual([400, 'invalid_cursor']);
  });
});

describe('dispensing', () => {
  it('dispenses in full from the batches chosen, completes the order and moves stock once', async () => {
    const rx = await prescribe([{ drugId: drugs.para, quantity: 12 }]);
    const later = await stockIn(drugs.para, 20, { expiryDays: 500 });
    const sooner = await stockIn(drugs.para, 8, { expiryDays: 200 });
    // The options offer the nearest expiry first.
    const line = await lineOf(rx.id);
    const options = await ok<{
      prescribed: { drugId: string; batches: { batchId: string }[] };
      substitutes: { drugId: string }[];
    }>(get(`/pharmacy/orders/${line.orderId}/options?locationId=${places.pharmacy}`));
    expect(options.prescribed.batches.map((each) => each.batchId).slice(0, 2)).toEqual([
      sooner,
      later,
    ]);
    expect(options.substitutes.map((each) => each.drugId)).toEqual([drugs.paraBrand]);

    const key = randomUUID();
    const body = [
      { batchId: sooner, quantity: 8 },
      { batchId: later, quantity: 4 },
    ];
    const given = await ok<Dispense>(dispense(line, body, {}, { key }), 201);
    expect(given).toMatchObject({
      orderId: line.orderId,
      drugId: drugs.para,
      itemName: 'Paracetamol 500 mg',
      quantity: 12,
      dispensedByName: 'Pharmacist',
    });
    expect(given.batches.map((each) => each.quantity)).toEqual([8, 4]);
    expect(await onHand(sooner)).toBe(0);
    expect(await onHand(later)).toBe(16);
    expect((await lineOf(rx.id)).status).toBe('completed');

    // The same key again: the same dispense, no stock moved.
    const again = await ok<Dispense>(
      post(
        '/pharmacy/dispenses',
        {
          orderId: line.orderId,
          expectedVersion: line.version,
          expectedDispensedQuantity: 0,
          locationId: places.pharmacy,
          batches: body,
        },
        { key },
      ),
      201,
    );
    expect(again.id).toBe(given.id);
    expect(await onHand(later)).toBe(16);
    const ledger = await pool.query<{ quantity: number; source: string; reason: string }>(
      'select quantity, source, reason from stock_ledger where source_id = $1 order by quantity',
      [given.id],
    );
    expect(ledger.rows).toEqual([
      { quantity: -8, source: 'dispense', reason: 'dispense' },
      { quantity: -4, source: 'dispense', reason: 'dispense' },
    ]);
    // Created once; the replay and the prescription read since are reads.
    expect(await audited('dispense', given.id)).toEqual(['create', 'read', 'read']);
    expect((await events(given.id)).map((each) => each.event)).toEqual(['pharmacy.dispensed']);
    expect((await events(line.orderId)).map((each) => each.event)).toContain('order.completed');
  });

  it('dispenses in part, then the rest, and refuses more than prescribed', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 10 }]);
    const batch = await stockIn(drugs.cetirizine, 30);
    const line = await lineOf(rx.id);
    await ok(dispense(line, [{ batchId: batch, quantity: 4 }]), 201);
    const part = await lineOf(rx.id);
    expect(part).toMatchObject({ status: 'in_progress', dispensedQuantity: 4 });
    // The version the first dispense was made from is gone.
    expect(errorOf(await dispense(line, [{ batchId: batch, quantity: 1 }]))).toEqual([
      409,
      'conflict',
    ]);
    expect(errorOf(await dispense(part, [{ batchId: batch, quantity: 7 }]))).toEqual([
      409,
      'over_quantity',
    ]);
    await ok(dispense(part, [{ batchId: batch, quantity: 6 }]), 201);
    expect(await lineOf(rx.id)).toMatchObject({ status: 'completed', dispensedQuantity: 10 });
    const done = await lineOf(rx.id);
    expect(errorOf(await dispense(done, [{ batchId: batch, quantity: 1 }]))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('refuses a second dispense made from the same reading of a line in progress', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine }]);
    const batch = await stockIn(drugs.cetirizine, 10);
    await ok(dispense(await lineOf(rx.id), [{ batchId: batch, quantity: 2 }]), 201);
    const part = await lineOf(rx.id);
    // Two counters read the line in progress: the first gives, the second is refused.
    await ok(dispense(part, [{ batchId: batch, quantity: 3 }]), 201);
    expect(errorOf(await dispense(part, [{ batchId: batch, quantity: 4 }]))).toEqual([
      409,
      'conflict',
    ]);
    expect(await onHand(batch)).toBe(5);
  });

  it('keeps a line with no quantity in progress until it is completed', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine }]);
    const batch = await stockIn(drugs.cetirizine, 5);
    const line = await lineOf(rx.id);
    expect(
      errorOf(
        await post(`/pharmacy/orders/${line.orderId}/complete`, { expectedVersion: line.version }),
      ),
    ).toEqual([409, 'invalid_transition']);
    await ok(dispense(line, [{ batchId: batch, quantity: 3 }]), 201);
    const part = await lineOf(rx.id);
    expect(part.status).toBe('in_progress');
    const completed = await ok<Prescription>(
      post(`/pharmacy/orders/${part.orderId}/complete`, { expectedVersion: part.version }),
    );
    expect(completed.lines[0]).toMatchObject({ status: 'completed', dispensedQuantity: 3 });
  });

  it('gives a generic substitute with a reason, and refuses another medicine', async () => {
    const rx = await prescribe([{ drugId: drugs.para, quantity: 2 }]);
    const brand = await stockIn(drugs.paraBrand, 10);
    const strong = await stockIn(drugs.paraStrong, 10);
    const line = await lineOf(rx.id);
    expect(
      errorOf(await dispense(line, [{ batchId: brand, quantity: 2 }], { drugId: drugs.paraBrand })),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await dispense(line, [{ batchId: strong, quantity: 2 }], {
          drugId: drugs.paraStrong,
          substitutionReason: 'Out of stock',
        }),
      ),
    ).toEqual([422, 'not_a_substitute']);
    // A batch of the prescribed item is not one of the substitute's.
    const own = await stockIn(drugs.para, 5);
    expect(
      errorOf(
        await dispense(line, [{ batchId: own, quantity: 2 }], {
          drugId: drugs.paraBrand,
          substitutionReason: 'Out of stock',
        }),
      ),
    ).toEqual([422, 'unknown_batch']);
    const given = await ok<Dispense>(
      dispense(line, [{ batchId: brand, quantity: 2 }], {
        drugId: drugs.paraBrand,
        substitutionReason: '  Out of   stock ',
      }),
      201,
    );
    expect(given).toMatchObject({
      drugId: drugs.paraBrand,
      itemName: 'Paracetamol 500 mg (Calpol)',
      substitutionReason: 'Out of stock',
    });
    expect(await onHand(brand)).toBe(8);
  });

  it('refuses an expired batch, a place not in use, too much, and a batch twice', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 5 }]);
    const line = await lineOf(rx.id);
    const expired = await stockIn(drugs.cetirizine, 5, { expiryDays: -3 });
    const fresh = await stockIn(drugs.cetirizine, 2);
    const inStore = await stockIn(drugs.cetirizine, 5, { locationId: places.store });
    expect(errorOf(await dispense(line, [{ batchId: expired, quantity: 1 }]))).toEqual([
      409,
      'batch_expired',
    ]);
    expect(errorOf(await dispense(line, [{ batchId: fresh, quantity: 3 }]))).toEqual([
      409,
      'insufficient_stock',
    ]);
    // Stock at another place is not at the counter.
    expect(errorOf(await dispense(line, [{ batchId: inStore, quantity: 1 }]))).toEqual([
      409,
      'insufficient_stock',
    ]);
    expect(
      errorOf(
        await dispense(line, [{ batchId: fresh, quantity: 1 }], { locationId: places.clinic }),
      ),
    ).toEqual([422, 'unknown_location']);
    expect(
      errorOf(
        await dispense(line, [
          { batchId: fresh, quantity: 1 },
          { batchId: fresh.toUpperCase(), quantity: 1 },
        ]),
      ),
    ).toEqual([422, 'unknown_batch']);
    // Nothing moved, nothing written.
    expect(await onHand(fresh)).toBe(2);
    expect((await lineOf(rx.id)).status).toBe('placed');
  });

  it('never oversells: two dispenses of the last units at once, one given', async () => {
    const first = await prescribe([{ drugId: drugs.cetirizine, quantity: 3 }]);
    const second = await prescribe([{ drugId: drugs.cetirizine, quantity: 3 }]);
    const batch = await stockIn(drugs.cetirizine, 3);
    const lines = [await lineOf(first.id), await lineOf(second.id)];
    const replies = await Promise.all(
      lines.map((line) => dispense(line, [{ batchId: batch, quantity: 3 }])),
    );
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    expect(replies.find((reply) => reply.statusCode === 409)?.json().error.code).toBe(
      'insufficient_stock',
    );
    expect(await onHand(batch)).toBe(0);
  });

  it('two dispenses of one line at once: one given, the other a conflict', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 4 }]);
    const batch = await stockIn(drugs.cetirizine, 10);
    const line = await lineOf(rx.id);
    const replies = await Promise.all([
      dispense(line, [{ batchId: batch, quantity: 2 }]),
      dispense(line, [{ batchId: batch, quantity: 2 }]),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    expect(await onHand(batch)).toBe(8);
  });

  it('emits stock.low when a dispense brings the item to its reorder level', async () => {
    const ibuprofen = await addDrug(hospital, 'Ibuprofen', { strength: '400 mg', reorderLevel: 5 });
    const batch = await stockIn(ibuprofen, 8);
    const first = await prescribe([{ drugId: ibuprofen, quantity: 3 }]);
    await ok(dispense(await lineOf(first.id), [{ batchId: batch, quantity: 3 }]), 201);
    const low = async () =>
      (await events(ibuprofen)).filter((each) => each.event === 'stock.low').length;
    expect(await low()).toBe(1);
    // Never again while it stays low.
    const second = await prescribe([{ drugId: ibuprofen, quantity: 1 }]);
    await ok(dispense(await lineOf(second.id), [{ batchId: batch, quantity: 1 }]), 201);
    expect(await low()).toBe(1);
  });

  it('records a printed slip', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 1 }]);
    const batch = await stockIn(drugs.cetirizine, 1);
    const given = await ok<Dispense>(
      dispense(await lineOf(rx.id), [{ batchId: batch, quantity: 1 }]),
      201,
    );
    const printed = await post(`/pharmacy/dispenses/${given.id}/print`);
    expect(printed.statusCode).toBe(204);
    expect(await audited('dispense', given.id)).toEqual(['create', 'print']);
  });
});

describe('the order', () => {
  it('is never completed with nothing given, and a cancelled one is not dispensed', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine }, { drugId: drugs.cetirizine }]);
    const batch = await stockIn(drugs.cetirizine, 2);
    const [first, second] = (await prescriptionOf(rx.id)).lines;
    if (!first || !second) throw new Error('two lines');
    // Moved in progress by the order route before the pharmacy was switched on.
    await pool.query(
      `update orders set status = 'accepted', status_changed_by = $2 where id = $1`,
      [first.orderId, admin.id],
    );
    await pool.query(
      `update orders set status = 'in_progress', status_changed_by = $2 where id = $1`,
      [first.orderId, admin.id],
    );
    const moved = await lineOf(rx.id);
    expect(
      errorOf(
        await post(`/pharmacy/orders/${moved.orderId}/complete`, {
          expectedVersion: moved.version,
        }),
      ),
    ).toEqual([409, 'invalid_transition']);
    await ok(
      post(
        `/orders/${second.orderId}/cancel`,
        { version: second.version, reason: 'Not needed' },
        { user: doctor },
      ),
    );
    const cancelled = await lineOf(rx.id, 1);
    expect(errorOf(await dispense(cancelled, [{ batchId: batch, quantity: 1 }]))).toEqual([
      409,
      'invalid_transition',
    ]);
  });

  it('is moved by its dispenses only while the pharmacy is on', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 1 }]);
    const line = await lineOf(rx.id);
    expect(
      errorOf(
        await post(
          `/orders/${line.orderId}/status`,
          { status: 'accepted', version: line.version },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'medication_order']);
  });
});

describe('access', () => {
  it('needs the permissions and the pharmacy switch', async () => {
    expect(errorOf(await get('/pharmacy/queue', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await get('/pharmacy/queue', { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('keeps each hospital to its own prescriptions, orders and dispenses', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 1 }]);
    const batch = await stockIn(drugs.cetirizine, 1);
    const line = await lineOf(rx.id);
    const other = { tenant: clinic, user: clinicPharmacist };
    expect(errorOf(await get(`/pharmacy/prescriptions/${rx.id}`, other))).toEqual([
      404,
      'prescription_not_found',
    ]);
    expect(
      errorOf(
        await get(`/pharmacy/orders/${line.orderId}/options?locationId=${places.clinic}`, other),
      ),
    ).toEqual([404, 'order_not_found']);
    expect(
      errorOf(
        await dispense(
          line,
          [{ batchId: batch, quantity: 1 }],
          { locationId: places.clinic },
          other,
        ),
      ),
    ).toEqual([404, 'order_not_found']);
    const queue = await ok<Page<QueueItem>>(get('/pharmacy/queue?limit=100', other));
    expect(queue.items.some((each) => each.prescriptionId === rx.id)).toBe(false);

    const given = await ok<Dispense>(dispense(line, [{ batchId: batch, quantity: 1 }]), 201);
    expect(errorOf(await post(`/pharmacy/dispenses/${given.id}/print`, undefined, other))).toEqual([
      404,
      'dispense_not_found',
    ]);
    // Under the app role, the clinic sees none of the hospital's dispenses or their lines.
    const seen = await asTenantSql(pool, clinic.id, async (client) => [
      (await client.query('select id from dispenses where id = $1', [given.id])).rowCount,
      (await client.query('select id from dispense_lines where dispense_id = $1', [given.id]))
        .rowCount,
    ]);
    expect(seen).toEqual([0, 0]);
    // And cannot write one for the hospital: a row valid in every way but its hospital is refused
    // by row-level security, not by a constraint.
    const encounterId = (await prescriptionOf(rx.id)).encounterId;
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into dispenses (tenant_id, order_id, prescription_id, encounter_id, patient_id,
             location_id, prescribed_drug_id, drug_id, item_name, schedule, controlled, quantity, dispensed_by)
           values ($1, $2, $3, $4, $5, $6, $7, $7, 'x', 'none', false, 1, $8)`,
          [
            hospital.id,
            line.orderId,
            rx.id,
            encounterId,
            patients.asha,
            places.pharmacy,
            drugs.cetirizine,
            pharmacist.id,
          ],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('reaches nothing with a scope narrower than the whole hospital', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 1 }]);
    await pool.query(
      "insert into roles (tenant_id, id, name) values ($1, 'own_pharmacist', 'Own pharmacist')",
      [hospital.id],
    );
    await pool.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope)
       values ($1, 'own_pharmacist', 'dispense:read', 'own'), ($1, 'own_pharmacist', 'dispense:create', 'own')`,
      [hospital.id],
    );
    const narrow = await createUser(pool, 'Own Pharmacist', { withPassword: false });
    await addMembership(pool, narrow, hospital, 'own_pharmacist');
    try {
      const queue = await ok<Page<QueueItem>>(get('/pharmacy/queue', { user: narrow }));
      expect(queue.items).toEqual([]);
      expect(errorOf(await get(`/pharmacy/prescriptions/${rx.id}`, { user: narrow }))).toEqual([
        404,
        'prescription_not_found',
      ]);
    } finally {
      await deleteUsers(pool, [narrow]);
    }
  });

  it('never changes a dispense', async () => {
    const rx = await prescribe([{ drugId: drugs.cetirizine, quantity: 1 }]);
    const batch = await stockIn(drugs.cetirizine, 1);
    const given = await ok<Dispense>(
      dispense(await lineOf(rx.id), [{ batchId: batch, quantity: 1 }]),
      201,
    );
    await expect(
      pool.query('update dispenses set quantity = 2 where id = $1', [given.id]),
    ).rejects.toThrow(/never changed/);
    await expect(
      pool.query('delete from dispense_lines where dispense_id = $1', [given.id]),
    ).rejects.toThrow(/never changed/);
  });
});
