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
 * The purchasing API through the real app and database: suppliers, purchase orders submitted by
 * one person and approved by another, goods received into stock through the ledger, goods sent
 * back; the hospital boundary, permissions, idempotency, audit, events and the database's own
 * rules (states, lines frozen once submitted, receipts and returns never changed).
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Purchasing switched off. */
let closed: TestTenant;
let admin: TestUser;
let keeper: TestUser;
let pharmacist: TestUser;
let clinicKeeper: TestUser;
/** A custom role that drafts and submits orders but neither approves nor receives. */
let buyer: TestUser;
const items = { amox: '', gloves: '', archived: '', clinicAmox: '' };
const places = { store: '', pharmacy: '', clinicStore: '' };
let supplierId = '';

interface Supplier {
  id: string;
  name: string;
  gstin?: string;
  phone?: string;
  archived: boolean;
  version: number;
}
interface OrderLine {
  id: string;
  drugId: string;
  quantity: number;
  unitCostMinor: number;
  receivedQuantity: number;
}
interface Order {
  id: string;
  reference: string;
  status: string;
  totalMinor: number;
  lines: OrderLine[];
  submittedByName?: string;
  approvedByName?: string;
  endNote?: string;
  version: number;
}
interface ReceiptLine {
  id: string;
  batchId: string;
  batchNumber: string;
  quantity: number;
  unitCostMinor: number;
  returnedQuantity: number;
}
interface Receipt {
  id: string;
  reference: string;
  orderReference: string;
  totalMinor: number;
  lines: ReceiptLine[];
}
interface Return {
  id: string;
  reference: string;
  receiptReference: string;
  totalMinor: number;
  lines: { batchId: string; quantity: number }[];
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
  headers: Record<string, unknown>;
  json: <T = { error: { code: string } }>() => T;
};

const get = (url: string, options: Options = {}) =>
  app.inject({
    url,
    headers: as((options.tenant ?? hospital).id, (options.user ?? keeper).id),
  });
const send = (method: 'POST' | 'PATCH', url: string, body?: object, options: Options = {}) => {
  const { tenant = hospital, user = keeper, key = randomUUID() } = options;
  return app.inject({
    method,
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': key },
    ...(body === undefined ? {} : { payload: body }),
  });
};
const post = (url: string, body?: object, options: Options = {}) =>
  send('POST', url, body, options);
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

let batchCount = 0;
const nextBatch = () => {
  batchCount += 1;
  return `P${String(batchCount).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6)}`;
};

async function addDrug(
  tenant: TestTenant,
  name: string,
  type: string,
  reorderLevel: number | null,
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into drugs (tenant_id, type, generic_name, form, unit, schedule, tax_class, reorder_level)
     values ($1, $2, $3, $4, 'piece', 'none', 'standard', $5) returning id`,
    [tenant.id, type, name, type === 'medicine' ? 'tablet' : 'device', reorderLevel],
  );
  return rows[0]?.id ?? '';
}

async function addPlace(tenant: TestTenant, name: string) {
  const reply = await post(
    '/inventory/locations',
    { name, kind: 'store' },
    { tenant, user: admin },
  );
  return (await ok<{ id: string }>(reply, 201)).id;
}

const draft = (lines: object[], options: Options = {}, extra: object = {}) =>
  post('/purchasing/orders', { supplierId, locationId: places.store, lines, ...extra }, options);
const step = (order: Order, action: string, options: Options = {}, body: object = {}) =>
  post(
    `/purchasing/orders/${order.id}/${action}`,
    { expectedVersion: order.version, ...body },
    options,
  );

/** An order drafted and submitted by the store keeper, approved by the admin. */
async function approvedOrder(
  lines: object[] = [{ drugId: items.amox, quantity: 100, unitCostMinor: 250 }],
) {
  const drafted = await ok<Order>(draft(lines), 201);
  const submitted = await ok<Order>(step(drafted, 'submit'));
  return ok<Order>(step(submitted, 'approve', { user: admin }));
}

const receive = (order: Order, lines: object[], options: Options = {}, extra: object = {}) =>
  post(`/purchasing/orders/${order.id}/receipts`, { lines, ...extra }, options);
const line = (orderLine: OrderLine | undefined, quantity: number, more: object = {}) => ({
  orderLineId: orderLine?.id ?? '',
  batchNumber: nextBatch(),
  expiryDate: day(400),
  quantity,
  // The agreed price: a dearer one is refused.
  unitCostMinor: orderLine?.unitCostMinor ?? 0,
  mrpMinor: 500,
  ...more,
});

const onHand = async (drugId: string, locationId = places.store) =>
  (
    await pool.query<{ total: number }>(
      'select coalesce(sum(on_hand), 0)::int as total from stock_balances where tenant_id = $1 and drug_id = $2 and location_id = $3',
      [hospital.id, drugId, locationId],
    )
  ).rows[0]?.total ?? 0;

const ledgerOf = async (sourceId: string) =>
  (
    await pool.query<{ quantity: number; source: string; reason: string; batch_id: string }>(
      'select quantity, source, reason, batch_id from stock_ledger where tenant_id = $1 and source_id = $2 order by at, id',
      [hospital.id, sourceId],
    )
  ).rows;

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
  const features = { drugs: true, inventory: true, purchasing: true };
  hospital = await createTenant(pool, 'Purchasing Hospital', { features });
  clinic = await createTenant(pool, 'Purchasing Clinic', { features });
  closed = await createTenant(pool, 'Purchasing Closed', {
    features: { ...features, purchasing: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Purchasing Admin');
  keeper = await user('Purchasing Keeper');
  pharmacist = await user('Purchasing Pharmacist');
  clinicKeeper = await user('Purchasing Clinic Keeper');
  buyer = await user('Purchasing Buyer');
  await pool.query(`insert into roles (tenant_id, id, name) values ($1, 'buyer', 'Buyer')`, [
    hospital.id,
  ]);
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission)
     select $1, 'buyer', unnest($2::text[])`,
    [hospital.id, ['supplier:read', 'purchaseOrder:read', 'purchaseOrder:create']],
  );
  await addMembership(pool, buyer, hospital, 'buyer');
  for (const tenant of [hospital, clinic, closed])
    await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, keeper, hospital, 'store_keeper');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicKeeper, clinic, 'store_keeper');
  items.amox = await addDrug(hospital, 'Amoxicillin', 'medicine', 50);
  items.gloves = await addDrug(hospital, 'Gloves', 'consumable', null);
  items.archived = await addDrug(hospital, 'Old item', 'medicine', null);
  await pool.query('update drugs set archived = true where id = $1', [items.archived]);
  items.clinicAmox = await addDrug(clinic, 'Amoxicillin', 'medicine', null);
  places.store = await addPlace(hospital, 'Main store');
  places.pharmacy = await addPlace(hospital, 'Pharmacy');
  places.clinicStore = await addPlace(clinic, 'Clinic store');
  supplierId = (await ok<Supplier>(post('/purchasing/suppliers', { name: 'Acme Pharma' }), 201)).id;
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Receipts, returns, the ledger and the balances refuse removal to everyone: the triggers are off here.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'purchase_return_lines',
      'purchase_returns',
      'goods_receipt_lines',
      'goods_receipts',
      'purchase_order_lines',
      'purchase_orders',
      'purchasing_counters',
      'suppliers',
      'stock_ledger',
      'stock_balances',
      'stock_batches',
      'stock_locations',
      'outbox',
      'drugs',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id, closed.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, keeper, pharmacist, clinicKeeper, buyer]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('suppliers', () => {
  it('adds, refuses a taken name, edits, clears a field and finds by name', async () => {
    const added = await ok<Supplier>(
      post('/purchasing/suppliers', {
        name: '  Zenith   Medical ',
        gstin: '27AAPFU0939F1ZV',
        phone: '+91 22 0000 0000',
      }),
      201,
    );
    expect(added).toMatchObject({ name: 'Zenith Medical', gstin: '27AAPFU0939F1ZV', version: 1 });
    expect(errorOf(await post('/purchasing/suppliers', { name: 'zenith MEDICAL' }))).toEqual([
      409,
      'supplier_name_taken',
    ]);
    expect(errorOf(await post('/purchasing/suppliers', { name: 'X', gstin: 'bad' }))).toEqual([
      400,
      'validation_failed',
    ]);
    const edited = await ok<Supplier>(
      send('PATCH', `/purchasing/suppliers/${added.id}`, { expectedVersion: 1, phone: null }),
    );
    expect(edited.phone).toBeUndefined();
    expect(edited.version).toBe(2);
    expect(
      errorOf(
        await send('PATCH', `/purchasing/suppliers/${added.id}`, { expectedVersion: 1, name: 'Y' }),
      ),
    ).toEqual([409, 'conflict']);
    const found = await ok<Page<Supplier>>(get('/purchasing/suppliers?q=ZENITH'));
    expect(found.items.map((each) => each.id)).toEqual([added.id]);
    expect(found.total).toBe(1);
    expect(await audited('supplier', added.id)).toEqual(['create', 'update']);
  });

  it('archives one without open orders only, and orders nothing from it once archived', async () => {
    const other = await ok<Supplier>(
      post('/purchasing/suppliers', { name: 'Brief Supplies' }),
      201,
    );
    const order = await ok<Order>(
      post('/purchasing/orders', {
        supplierId: other.id,
        locationId: places.store,
        lines: [{ drugId: items.gloves, quantity: 5, unitCostMinor: 100 }],
      }),
      201,
    );
    expect(errorOf(await post(`/purchasing/suppliers/${other.id}/archive`))).toEqual([
      409,
      'supplier_has_open_orders',
    ]);
    await ok(step(order, 'cancel', {}, { note: 'Not needed' }));
    expect((await ok<Supplier>(post(`/purchasing/suppliers/${other.id}/archive`))).archived).toBe(
      true,
    );
    expect(
      errorOf(
        await post('/purchasing/orders', {
          supplierId: other.id,
          locationId: places.store,
          lines: [{ drugId: items.gloves, quantity: 5, unitCostMinor: 100 }],
        }),
      ),
    ).toEqual([400, 'validation_failed']);
  });

  it('is the store keeper’s and the admin’s, not the pharmacist’s', async () => {
    expect(errorOf(await get('/purchasing/suppliers', { user: pharmacist }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      errorOf(await post('/purchasing/suppliers', { name: 'No' }, { user: pharmacist })),
    ).toEqual([403, 'permission_denied']);
  });
});

describe('purchase orders', () => {
  it('drafts, edits, submits, and is approved by someone else only', async () => {
    expect(
      errorOf(
        await draft([
          { drugId: items.amox, quantity: 1, unitCostMinor: 1 },
          { drugId: items.amox, quantity: 2, unitCostMinor: 1 },
        ]),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await draft([{ drugId: items.archived, quantity: 1, unitCostMinor: 1 }])),
    ).toEqual([400, 'validation_failed']);
    const drafted = await ok<Order>(
      draft([{ drugId: items.amox, quantity: 10, unitCostMinor: 300 }]),
      201,
    );
    expect(drafted).toMatchObject({ status: 'draft', totalMinor: 3000 });
    expect(drafted.reference).toMatch(/^PO-\d{6}$/);
    const edited = await ok<Order>(
      send('PATCH', `/purchasing/orders/${drafted.id}`, {
        expectedVersion: drafted.version,
        lines: [
          { drugId: items.amox, quantity: 20, unitCostMinor: 300 },
          { drugId: items.gloves, quantity: 4, unitCostMinor: 50 },
        ],
      }),
    );
    expect(edited.totalMinor).toBe(6200);
    expect(edited.version).toBe(drafted.version + 1);
    const submitted = await ok<Order>(step(edited, 'submit'));
    expect(submitted.status).toBe('submitted');
    expect(
      errorOf(
        await send('PATCH', `/purchasing/orders/${drafted.id}`, {
          expectedVersion: submitted.version,
          note: 'Too late',
        }),
      ),
    ).toEqual([409, 'order_status']);
    expect(errorOf(await step(submitted, 'approve'))).toEqual([409, 'own_order']);
    expect(errorOf(await step(submitted, 'approve', { user: pharmacist }))).toEqual([
      403,
      'permission_denied',
    ]);
    const approved = await ok<Order>(step(submitted, 'approve', { user: admin }));
    expect(approved).toMatchObject({ status: 'approved', approvedByName: 'Purchasing Admin' });
    expect((await events(approved.id)).map((each) => each.event)).toEqual([
      'purchase.order_approved',
    ]);
    expect(await audited('purchase_order', approved.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
    ]);
    const listed = await ok<Page<{ id: string }>>(
      get(`/purchasing/orders?status=approved&supplierId=${supplierId}`),
    );
    expect(listed.items.map((each) => each.id)).toContain(approved.id);
  });

  it('cancels one nothing came in for, and closes one partly received', async () => {
    const approved = await approvedOrder();
    const cancelled = await ok<Order>(step(approved, 'cancel', {}, { note: 'Price changed' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', endNote: 'Price changed' });
    expect(errorOf(await step(cancelled, 'close', {}, { note: 'X' }))).toEqual([
      409,
      'order_status',
    ]);
    const other = await approvedOrder();
    await ok(receive(other, [line(other.lines[0], 40)]), 201);
    const partly = await ok<Order>(get(`/purchasing/orders/${other.id}`));
    expect(partly.status).toBe('partly_received');
    expect(errorOf(await step(partly, 'cancel', {}, { note: 'X' }))).toEqual([409, 'order_status']);
    const closedOrder = await ok<Order>(step(partly, 'close', {}, { note: 'Rest discontinued' }));
    expect(closedOrder.status).toBe('closed');
    expect(errorOf(await receive(closedOrder, [line(closedOrder.lines[0], 1)]))).toEqual([
      409,
      'order_status',
    ]);
  });
});

describe('goods receipts', () => {
  it('adds batches and ledger entries, and the order follows what came in', async () => {
    const order = await approvedOrder([
      { drugId: items.amox, quantity: 100, unitCostMinor: 250 },
      { drugId: items.gloves, quantity: 10, unitCostMinor: 80 },
    ]);
    const [amox, gloves] = order.lines;
    const before = await onHand(items.amox);
    const first = await ok<Receipt>(
      receive(
        order,
        [line(amox, 30), line(amox, 20, { expiryDate: day(500) }), line(gloves, 10)],
        {},
        { supplierInvoice: 'INV-77' },
      ),
      201,
    );
    expect(first.reference).toMatch(/^GRN-\d{6}$/);
    expect(first.orderReference).toBe(order.reference);
    expect(first.totalMinor).toBe(50 * 250 + 10 * 80);
    expect(await onHand(items.amox)).toBe(before + 50);
    const entries = await ledgerOf(first.id);
    // One transaction: the entries share their instant, so they are compared in any order.
    expect(entries.map((entry) => [entry.quantity, entry.source, entry.reason]).sort()).toEqual([
      [10, 'receipt', 'receipt'],
      [20, 'receipt', 'receipt'],
      [30, 'receipt', 'receipt'],
    ]);
    expect(new Set(entries.map((entry) => entry.batch_id))).toEqual(
      new Set(first.lines.map((each) => each.batchId)),
    );
    const { rows: batch } = await pool.query<{ cost_minor: string; mrp_minor: string }>(
      'select cost_minor::text, mrp_minor::text from stock_batches where id = $1',
      [first.lines[0]?.batchId],
    );
    expect(batch[0]).toEqual({ cost_minor: '250', mrp_minor: '500' });
    const partly = await ok<Order>(get(`/purchasing/orders/${order.id}`));
    expect(partly.status).toBe('partly_received');
    expect(partly.lines.map((each) => each.receivedQuantity)).toEqual([50, 10]);
    expect(errorOf(await receive(partly, [line(amox, 51)]))).toEqual([409, 'over_receipt']);
    // The rest, in a batch the hospital already has: the same expiry date adds to it.
    const again = first.lines[0];
    await ok(
      receive(partly, [line(amox, 50, { batchNumber: again?.batchNumber.toLowerCase() })]),
      201,
    );
    const received = await ok<Order>(get(`/purchasing/orders/${order.id}`));
    expect(received.status).toBe('received');
    expect(await onHand(items.amox)).toBe(before + 100);
    expect((await events(first.id)).map((each) => each.event)).toEqual(['stock.received']);
    expect(await audited('goods_receipt', first.id)).toEqual(['create']);
    const listed = await ok<Page<{ id: string }>>(get(`/purchasing/receipts?orderId=${order.id}`));
    expect(listed.total).toBe(2);
  });

  it('refuses a batch number of the item with another expiry, an expired batch and a line of another order', async () => {
    const order = await approvedOrder();
    const existing = await ok<Receipt>(receive(order, [line(order.lines[0], 5)]), 201);
    const number = existing.lines[0]?.batchNumber;
    expect(
      errorOf(
        await receive(order, [
          line(order.lines[0], 5, { batchNumber: number, expiryDate: day(90) }),
        ]),
      ),
    ).toEqual([409, 'batch_exists']);
    expect(
      errorOf(await receive(order, [line(order.lines[0], 5, { expiryDate: day(-3) })])),
    ).toEqual([409, 'batch_expired']);
    const other = await approvedOrder();
    expect(errorOf(await receive(order, [line(other.lines[0], 5)]))).toEqual([
      400,
      'validation_failed',
    ]);
    const twice = nextBatch();
    expect(
      errorOf(
        await receive(order, [
          line(order.lines[0], 1, { batchNumber: twice }),
          line(order.lines[0], 1, { batchNumber: twice.toLowerCase() }),
        ]),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(errorOf(await receive(other, [line(other.lines[0], 1)], { user: pharmacist }))).toEqual([
      403,
      'permission_denied',
    ]);
    const drafted = await ok<Order>(
      draft([{ drugId: items.amox, quantity: 1, unitCostMinor: 1 }]),
      201,
    );
    expect(errorOf(await receive(drafted, [line(drafted.lines[0], 1)]))).toEqual([
      409,
      'order_status',
    ]);
  });

  it('is received once for a key, and two receipts of the last units bring in one', async () => {
    const order = await approvedOrder([{ drugId: items.gloves, quantity: 10, unitCostMinor: 80 }]);
    const before = await onHand(items.gloves);
    const key = randomUUID();
    const body = [line(order.lines[0], 4)];
    const first = await receive(order, body, { key });
    const replay = await receive(order, body, { key });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<Receipt>().id).toBe(first.json<Receipt>().id);
    expect(await onHand(items.gloves)).toBe(before + 4);
    const both = await Promise.all([
      receive(order, [line(order.lines[0], 6)]),
      receive(order, [line(order.lines[0], 6)]),
    ]);
    expect(both.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    expect(await onHand(items.gloves)).toBe(before + 10);
  });
});

describe('returns to the supplier', () => {
  it('sends units back through the ledger, no more than came in or is there', async () => {
    const order = await approvedOrder();
    const receipt = await ok<Receipt>(receive(order, [line(order.lines[0], 60)]), 201);
    const receiptLine = receipt.lines[0];
    const before = await onHand(items.amox);
    expect(
      errorOf(
        await post(`/purchasing/receipts/${receipt.id}/returns`, {
          reason: 'other',
          lines: [{ receiptLineId: receiptLine?.id, quantity: 1 }],
        }),
      ),
    ).toEqual([400, 'validation_failed']);
    const sent = await ok<Return>(
      post(`/purchasing/receipts/${receipt.id}/returns`, {
        reason: 'damaged',
        lines: [{ receiptLineId: receiptLine?.id, quantity: 15 }],
      }),
      201,
    );
    expect(sent.reference).toMatch(/^PRN-\d{6}$/);
    expect(sent.receiptReference).toBe(receipt.reference);
    expect(sent.totalMinor).toBe(15 * 250);
    expect(await onHand(items.amox)).toBe(before - 15);
    expect((await ledgerOf(sent.id)).map((entry) => [entry.quantity, entry.source])).toEqual([
      [-15, 'purchase_return'],
    ]);
    expect(
      errorOf(
        await post(`/purchasing/receipts/${receipt.id}/returns`, {
          reason: 'damaged',
          lines: [{ receiptLineId: receiptLine?.id, quantity: 46 }],
        }),
      ),
    ).toEqual([409, 'over_return']);
    // From a place where the batch has none.
    expect(
      errorOf(
        await post(`/purchasing/receipts/${receipt.id}/returns`, {
          locationId: places.pharmacy,
          reason: 'damaged',
          lines: [{ receiptLineId: receiptLine?.id, quantity: 1 }],
        }),
      ),
    ).toEqual([409, 'insufficient_stock']);
    const again = await ok<Receipt>(get(`/purchasing/receipts/${receipt.id}`));
    expect(again.lines[0]?.returnedQuantity).toBe(15);
    expect((await events(sent.id)).map((each) => each.event)).toEqual(['stock.returned']);
    expect(await audited('purchase_return', sent.id)).toEqual(['create']);
    const listed = await ok<Page<Return>>(get(`/purchasing/returns?receiptId=${receipt.id}`));
    expect(listed.items.map((each) => each.lines.length)).toEqual([1]);
  });
});

describe('who may do what', () => {
  it('lets nobody who drafted, changed or submitted an order approve it', async () => {
    // The admin changes the store keeper's draft and the store keeper submits: neither approves.
    const drafted = await ok<Order>(
      draft([{ drugId: items.gloves, quantity: 5, unitCostMinor: 90 }]),
      201,
    );
    const edited = await ok<Order>(
      send(
        'PATCH',
        `/purchasing/orders/${drafted.id}`,
        {
          expectedVersion: drafted.version,
          lines: [{ drugId: items.gloves, quantity: 9, unitCostMinor: 90 }],
        },
        { user: admin },
      ),
    );
    const submitted = await ok<Order>(step(edited, 'submit'));
    expect(errorOf(await step(submitted, 'approve', { user: admin }))).toEqual([409, 'own_order']);
    expect(errorOf(await step(submitted, 'approve'))).toEqual([409, 'own_order']);
    // Nor the creator, when someone else submitted it.
    const other = await ok<Order>(
      draft([{ drugId: items.gloves, quantity: 5, unitCostMinor: 90 }]),
      201,
    );
    const sent = await ok<Order>(step(other, 'submit', { user: buyer }));
    expect(errorOf(await step(sent, 'approve'))).toEqual([409, 'own_order']);
    expect((await ok<Order>(step(sent, 'approve', { user: admin }))).status).toBe('approved');
  });

  it('keeps approving and receiving from a custom role that only buys', async () => {
    const drafted = await ok<Order>(
      draft([{ drugId: items.gloves, quantity: 5, unitCostMinor: 90 }], { user: buyer }),
      201,
    );
    const submitted = await ok<Order>(step(drafted, 'submit', { user: buyer }));
    expect(errorOf(await step(submitted, 'approve', { user: buyer }))).toEqual([
      403,
      'permission_denied',
    ]);
    const approved = await ok<Order>(step(submitted, 'approve', { user: admin }));
    expect(errorOf(await receive(approved, [line(approved.lines[0], 1)], { user: buyer }))).toEqual(
      [403, 'permission_denied'],
    );
  });
});

describe('the price and the item received', () => {
  it('refuses a cost above the agreed price and an item archived since the order', async () => {
    const order = await approvedOrder([{ drugId: items.gloves, quantity: 10, unitCostMinor: 80 }]);
    expect(errorOf(await receive(order, [line(order.lines[0], 1, { unitCostMinor: 81 })]))).toEqual(
      [409, 'cost_above_order'],
    );
    // A cheaper delivery is received at what it cost.
    const cheaper = await ok<Receipt>(
      receive(order, [line(order.lines[0], 1, { unitCostMinor: 70 })]),
      201,
    );
    expect(cheaper.totalMinor).toBe(70);
    const item = await addDrug(hospital, 'Soon archived', 'medicine', null);
    const later = await approvedOrder([{ drugId: item, quantity: 10, unitCostMinor: 80 }]);
    await pool.query('update drugs set archived = true where id = $1', [item]);
    expect(errorOf(await receive(later, [line(later.lines[0], 1, { unitCostMinor: 80 })]))).toEqual(
      [409, 'item_archived'],
    );
  });

  it('moves the order’s version with each receipt, so a step read before it is refused', async () => {
    const order = await approvedOrder([{ drugId: items.gloves, quantity: 10, unitCostMinor: 80 }]);
    await ok(receive(order, [line(order.lines[0], 2, { unitCostMinor: 80 })]), 201);
    const partly = await ok<Order>(get(`/purchasing/orders/${order.id}`));
    await ok(receive(partly, [line(partly.lines[0], 2, { unitCostMinor: 80 })]), 201);
    expect(errorOf(await step(partly, 'close', {}, { note: 'Stale' }))).toEqual([409, 'conflict']);
  });
});

describe('returns of the last units and of expired ones', () => {
  it('sends the last units back once when two returns race', async () => {
    const order = await approvedOrder();
    const receipt = await ok<Receipt>(receive(order, [line(order.lines[0], 6)]), 201);
    const body = {
      reason: 'damaged',
      lines: [{ receiptLineId: receipt.lines[0]?.id, quantity: 6 }],
    };
    const both = await Promise.all([
      post(`/purchasing/receipts/${receipt.id}/returns`, body),
      post(`/purchasing/receipts/${receipt.id}/returns`, body),
    ]);
    expect(both.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    const refused = both.find((reply) => reply.statusCode === 409);
    expect(refused && errorOf(refused)).toEqual([409, 'over_return']);
  });

  it('sends expired units back to the supplier, and says when stock falls to the reorder level', async () => {
    // An expired batch received earlier, as the API would have made it before it expired.
    // An item of its own with a reorder level of 100, whose only stock is this batch.
    const drugId = await addDrug(hospital, 'Expiring returned', 'medicine', 100);
    const order = await approvedOrder([{ drugId, quantity: 500, unitCostMinor: 250 }]);
    const orderLine = order.lines[0];
    const { rows: batch } = await pool.query<{ id: string }>(
      `insert into stock_batches (tenant_id, drug_id, batch_number, expiry_date, cost_minor, created_by)
       values ($1, $2, $3, current_date - 10, 250, $4) returning id`,
      [hospital.id, drugId, nextBatch(), keeper.id],
    );
    const { rows: receipt } = await pool.query<{ id: string }>(
      `insert into goods_receipts (tenant_id, number, order_id, supplier_id, location_id, received_by)
       values ($1, 900000 + floor(random() * 99999)::int, $2, $3, $4, $5) returning id`,
      [hospital.id, order.id, supplierId, places.store, keeper.id],
    );
    const { rows: entry } = await pool.query<{ id: string }>(
      `insert into stock_ledger (tenant_id, batch_id, drug_id, location_id, quantity, source, source_id, reason, actor_id)
       values ($1, $2, $3, $4, 400, 'receipt', $5, 'receipt', $6) returning id`,
      [hospital.id, batch[0]?.id, drugId, places.store, receipt[0]?.id, keeper.id],
    );
    const { rows: receiptLine } = await pool.query<{ id: string }>(
      `insert into goods_receipt_lines (tenant_id, receipt_id, order_id, order_line_id, line_number, drug_id,
         batch_id, quantity, unit_cost_minor, ledger_entry_id)
       values ($1, $2, $3, $4, 1, $5, $6, 400, 250, $7) returning id`,
      [hospital.id, receipt[0]?.id, order.id, orderLine?.id, drugId, batch[0]?.id, entry[0]?.id],
    );
    const sent = await ok<Return>(
      post(`/purchasing/receipts/${receipt[0]?.id}/returns`, {
        reason: 'expired',
        lines: [{ receiptLineId: receiptLine[0]?.id, quantity: 350 }],
      }),
      201,
    );
    expect(sent.lines).toMatchObject([{ quantity: 350 }]);
    expect(await onHand(drugId)).toBe(50);
    // From 400 to 50, past the level of 100: the item is said to be low.
    const low = await pool.query(
      `select 1 from outbox where tenant_id = $1 and event = 'stock.low' and entity_id = $2
       and payload->>'drugId' = $2 and occurred_at > now() - interval '1 minute'`,
      [hospital.id, drugId],
    );
    expect(low.rowCount).toBe(1);
  });
});

describe('the hospital boundary', () => {
  it('shows one hospital nothing of another’s', async () => {
    const order = await approvedOrder();
    const receipt = await ok<Receipt>(receive(order, [line(order.lines[0], 3)]), 201);
    const asClinic = { tenant: clinic, user: clinicKeeper };
    expect(errorOf(await get(`/purchasing/orders/${order.id}`, asClinic))).toEqual([
      404,
      'order_not_found',
    ]);
    expect(errorOf(await get(`/purchasing/receipts/${receipt.id}`, asClinic))).toEqual([
      404,
      'receipt_not_found',
    ]);
    expect(errorOf(await get(`/purchasing/suppliers/${supplierId}`, asClinic))).toEqual([
      404,
      'supplier_not_found',
    ]);
    expect(
      errorOf(
        await post(
          '/purchasing/orders',
          {
            supplierId,
            locationId: places.clinicStore,
            lines: [{ drugId: items.clinicAmox, quantity: 1, unitCostMinor: 1 }],
          },
          asClinic,
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await post(
          `/purchasing/receipts/${receipt.id}/returns`,
          { reason: 'damaged', lines: [{ receiptLineId: receipt.lines[0]?.id, quantity: 1 }] },
          asClinic,
        ),
      ),
    ).toEqual([404, 'receipt_not_found']);
    const clinicList = await ok<Page<unknown>>(get('/purchasing/orders', asClinic));
    expect(clinicList.items).toEqual([]);
    for (const table of [
      'suppliers',
      'purchasing_counters',
      'purchase_orders',
      'purchase_order_lines',
      'goods_receipts',
      'goods_receipt_lines',
      'purchase_returns',
      'purchase_return_lines',
    ]) {
      const seen = await asTenantSql(pool, clinic.id, async (client) =>
        (
          await client.query<{ tenant_id: string }>(`select distinct tenant_id from ${table}`)
        ).rows.map((row) => row.tenant_id),
      );
      expect([table, seen.filter((id) => id !== clinic.id)]).toEqual([table, []]);
    }
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(`insert into suppliers (tenant_id, name) values ($1, 'Stolen')`, [
          hospital.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('is closed when the hospital has purchasing switched off', async () => {
    expect(errorOf(await get('/purchasing/orders', { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the database’s own rules', () => {
  it('keeps receipts and returns, freezes a submitted order’s lines, and moves an order along its states only', async () => {
    const order = await approvedOrder();
    const receipt = await ok<Receipt>(receive(order, [line(order.lines[0], 2)]), 201);
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('update goods_receipt_lines set quantity = 1 where receipt_id = $1', [
          receipt.id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('delete from purchase_order_lines where order_id = $1', [order.id]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query(`update purchase_orders set status = 'draft' where id = $1`, [order.id]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    for (const table of ['goods_receipts', 'purchase_returns']) {
      await expect(pool.query(`truncate ${table} cascade`)).rejects.toThrow('never emptied');
    }
  });
});
