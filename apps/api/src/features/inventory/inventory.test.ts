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
 * The inventory API through the real app and database: places, adjustments asked for by one
 * person and approved by another, the ledger, stock and its alerts; the hospital boundary,
 * permissions, audit, events and the database's own rules (the ledger is the only way stock
 * moves, never below zero, append-only).
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** Inventory switched off. */
let closed: TestTenant;
let admin: TestUser;
let keeper: TestUser;
let pharmacist: TestUser;
let doctor: TestUser;
let clinicKeeper: TestUser;
const items = { amox: '', gloves: '', clinicAmox: '' };
const places = { store: '', pharmacy: '', clinicStore: '' };

interface Location {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
  version: number;
}
interface Adjustment {
  id: string;
  batchId?: string;
  batchNumber: string;
  expiryDate: string;
  newBatch: boolean;
  quantity: number;
  onHand: number;
  status: string;
  requestedByName: string;
  decidedByName?: string;
  rejectionNote?: string;
  version: number;
}
interface StockItem {
  item: { drugId: string; genericName: string };
  onHand: number;
  hospitalOnHand: number;
  low: boolean;
  reorderLevel?: number;
  batches: {
    batchId: string;
    batchNumber: string;
    locationId: string;
    onHand: number;
    expiry: string;
  }[];
}
interface LedgerEntry {
  id: string;
  quantity: number;
  balanceAfter: number;
  reason: string;
  source: string;
  sourceId: string;
  actorName: string;
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
  return `B${String(batchCount).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6)}`;
};

const ask = (body: object, options: Options = {}) => post('/inventory/adjustments', body, options);
const approve = (adjustment: Adjustment, options: Options = {}) =>
  post(
    `/inventory/adjustments/${adjustment.id}/approve`,
    { expectedVersion: adjustment.version },
    { user: admin, ...options },
  );

/** Opening stock of a new batch, asked by the store keeper and approved by the admin. */
async function opening(
  quantity: number,
  { drugId = items.amox, locationId = places.store, expiryDays = 400 } = {},
) {
  const asked = await ok<Adjustment>(
    ask({
      locationId,
      drugId,
      batchNumber: nextBatch(),
      expiryDate: day(expiryDays),
      mrpMinor: 12550,
      quantity,
      reason: 'opening',
    }),
    201,
  );
  return ok<Adjustment>(approve(asked));
}

const stock = (query: string, options: Options = {}) =>
  ok<Page<StockItem>>(get(`/inventory/stock?limit=100&${query}`, options));
async function itemOf(drugId: string, query = ''): Promise<StockItem> {
  const item = (await stock(`drugId=${drugId}&${query}`)).items[0];
  if (!item) throw new Error('the item is not listed');
  return item;
}

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

async function addPlace(tenant: TestTenant, user: TestUser, name: string, kind = 'store') {
  return (await ok<Location>(post('/inventory/locations', { name, kind }, { tenant, user }), 201))
    .id;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { drugs: true, inventory: true };
  hospital = await createTenant(pool, 'Inventory Hospital', { features });
  clinic = await createTenant(pool, 'Inventory Clinic', { features });
  closed = await createTenant(pool, 'Inventory Closed', {
    features: { ...features, inventory: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Inventory Admin');
  keeper = await user('Store Keeper');
  pharmacist = await user('Pharmacist');
  doctor = await user('Inventory Doctor');
  clinicKeeper = await user('Clinic Keeper');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, clinic, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, keeper, hospital, 'store_keeper');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, clinicKeeper, clinic, 'store_keeper');
  items.amox = await addDrug(hospital, 'Amoxicillin', 'medicine', 100);
  items.gloves = await addDrug(hospital, 'Gloves', 'consumable', null);
  items.clinicAmox = await addDrug(clinic, 'Amoxicillin', 'medicine', null);
  places.store = await addPlace(hospital, admin, 'Main store');
  places.pharmacy = await addPlace(hospital, admin, 'Pharmacy', 'pharmacy');
  places.clinicStore = await addPlace(clinic, admin, 'Clinic store');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The ledger and the balances refuse removal to everyone: the triggers are off here.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'stock_ledger',
      'stock_balances',
      'stock_adjustments',
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
  await deleteUsers(pool, [admin, keeper, pharmacist, doctor, clinicKeeper]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('places', () => {
  it('adds, renames, refuses a taken name, and archives only a place without stock', async () => {
    const id = await addPlace(hospital, admin, 'Ward 3 stock', 'ward');
    expect(
      errorOf(
        await post('/inventory/locations', { name: 'ward 3 STOCK', kind: 'ward' }, { user: admin }),
      ),
    ).toEqual([409, 'location_name_taken']);
    const renamed = await ok<Location>(
      send(
        'PATCH',
        `/inventory/locations/${id}`,
        { expectedVersion: 1, name: '  Ward 3   store ' },
        { user: admin },
      ),
    );
    expect(renamed).toMatchObject({ name: 'Ward 3 store', kind: 'ward', version: 2 });
    expect(
      errorOf(
        await send(
          'PATCH',
          `/inventory/locations/${id}`,
          { expectedVersion: 1, name: 'X' },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'conflict']);

    await opening(5, { drugId: items.gloves, locationId: id });
    expect(
      errorOf(await post(`/inventory/locations/${id}/archive`, undefined, { user: admin })),
    ).toEqual([409, 'location_has_stock']);
    const empty = await addPlace(hospital, admin, 'Empty corner');
    expect(
      await ok<Location>(post(`/inventory/locations/${empty}/archive`, undefined, { user: admin })),
    ).toMatchObject({ archived: true });
    expect(await audited('stock_location', empty)).toEqual(['create', 'archive']);
    const archived = await ok<Page<Location>>(get('/inventory/locations?archived=true'));
    expect(archived.items.map((each) => each.id)).toContain(empty);
    // Nothing is moved to an archived place.
    expect(
      errorOf(
        await ask({
          locationId: empty,
          drugId: items.gloves,
          batchNumber: nextBatch(),
          expiryDate: day(300),
          quantity: 1,
          reason: 'opening',
        }),
      ),
    ).toEqual([400, 'validation_failed']);
  });

  it('is managed by the admin alone', async () => {
    expect(
      errorOf(await post('/inventory/locations', { name: 'Keeper place', kind: 'store' })),
    ).toEqual([403, 'permission_denied']);
    expect((await get('/inventory/locations', { user: pharmacist })).statusCode).toBe(200);
  });
});

describe('adjustments', () => {
  it('opens a new batch only once a second person approves it, and posts it to the ledger', async () => {
    const batchNumber = nextBatch();
    const asked = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId: items.gloves,
        batchNumber,
        expiryDate: day(500),
        costMinor: 400,
        quantity: 200,
        reason: 'opening',
        note: 'First count',
      }),
      201,
    );
    expect(asked).toMatchObject({
      status: 'pending',
      newBatch: true,
      onHand: 0,
      requestedByName: 'Store Keeper',
    });
    expect(asked.batchId).toBeUndefined();
    // Nothing moved while pending.
    expect(
      (await itemOf(items.gloves)).batches.find((b) => b.batchNumber === batchNumber),
    ).toBeUndefined();
    // The one who asked never approves.
    expect(errorOf(await approve(asked, { user: keeper }))).toEqual([409, 'own_adjustment']);
    expect(
      errorOf(
        await post(
          `/inventory/adjustments/${asked.id}/approve`,
          { expectedVersion: 9 },
          { user: admin },
        ),
      ),
    ).toEqual([409, 'conflict']);

    const approved = await ok<Adjustment>(approve(asked));
    expect(approved).toMatchObject({
      status: 'approved',
      onHand: 200,
      decidedByName: 'Inventory Admin',
    });
    expect(approved.batchId).toBeDefined();
    expect(errorOf(await approve(approved))).toEqual([409, 'adjustment_decided']);

    const ledger = await ok<Page<LedgerEntry>>(
      get(`/inventory/ledger?batchId=${approved.batchId}`),
    );
    expect(ledger.items).toEqual([
      expect.objectContaining({
        quantity: 200,
        balanceAfter: 200,
        reason: 'opening',
        source: 'adjustment',
        sourceId: asked.id,
        actorName: 'Inventory Admin',
      }),
    ]);
    expect(await audited('stock_adjustment', asked.id)).toEqual(['create', 'update']);
    expect((await events(asked.id)).map((each) => each.event)).toEqual(['stock.adjusted']);
    expect(JSON.stringify(await events(asked.id))).not.toContain('First count');
  });

  it('takes stock out of a batch, never below what the place has', async () => {
    const opened = await opening(30);
    const batchId = opened.batchId ?? '';
    expect(
      errorOf(
        await ask({
          locationId: places.store,
          drugId: items.amox,
          batchId,
          quantity: -31,
          reason: 'damaged',
        }),
      ),
    ).toEqual([409, 'insufficient_stock']);
    // Another place has none of it.
    expect(
      errorOf(
        await ask({
          locationId: places.pharmacy,
          drugId: items.amox,
          batchId,
          quantity: -1,
          reason: 'count_correction',
        }),
      ),
    ).toEqual([409, 'insufficient_stock']);

    const damaged = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId: items.amox,
        batchId,
        quantity: -10,
        reason: 'damaged',
      }),
      201,
    );
    expect(await ok<Adjustment>(approve(damaged))).toMatchObject({ onHand: 20 });
    const entries = await ok<Page<LedgerEntry>>(get(`/inventory/ledger?batchId=${batchId}`));
    expect(entries.items.map((each) => [each.quantity, each.balanceAfter])).toEqual([
      [-10, 20],
      [30, 30],
    ]);
  });

  it('checks again on approval: two adjustments of the last units, only one moves them', async () => {
    const opened = await opening(10);
    const batchId = opened.batchId ?? '';
    const body = {
      locationId: places.store,
      drugId: items.amox,
      batchId,
      quantity: -8,
      reason: 'count_correction',
    };
    const first = await ok<Adjustment>(ask(body), 201);
    const second = await ok<Adjustment>(ask(body), 201);
    const results = await Promise.all([approve(first), approve(second)]);
    expect(results.map((each) => each.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((each) => each.statusCode === 409)?.json().error.code).toBe(
      'insufficient_stock',
    );
    const batch = (await itemOf(items.amox)).batches.find((b) => b.batchId === batchId);
    expect(batch?.onHand).toBe(2);
  });

  it('refuses what makes no sense for its reason', async () => {
    const base = { locationId: places.store, drugId: items.gloves };
    const opened = await opening(3, { drugId: items.gloves });
    const cases: [object, string][] = [
      [
        { ...base, batchNumber: nextBatch(), expiryDate: day(10), quantity: -1, reason: 'opening' },
        'validation_failed',
      ],
      [{ ...base, batchId: opened.batchId, quantity: 1, reason: 'damaged' }, 'validation_failed'],
      [{ ...base, batchId: opened.batchId, quantity: 0, reason: 'other' }, 'validation_failed'],
      [
        {
          ...base,
          batchNumber: nextBatch(),
          expiryDate: day(10),
          quantity: 1,
          reason: 'count_correction',
        },
        'validation_failed',
      ],
      [
        {
          ...base,
          batchNumber: nextBatch(),
          expiryDate: '2027-02-30',
          quantity: 1,
          reason: 'opening',
        },
        'validation_failed',
      ],
      [
        { ...base, batchId: opened.batchId, batchNumber: 'X', quantity: 1, reason: 'opening' },
        'validation_failed',
      ],
      [
        { ...base, batchId: (await opening(1)).batchId, quantity: 1, reason: 'other' },
        'validation_failed',
      ],
      [
        {
          ...base,
          batchNumber: opened.batchNumber.toLowerCase(),
          expiryDate: day(10),
          quantity: 1,
          reason: 'opening',
        },
        'batch_exists',
      ],
    ];
    for (const [body, code] of cases) {
      expect([body, (await ask(body)).json().error.code]).toEqual([body, code]);
    }
  });

  it('is rejected with a note, and nothing moves', async () => {
    const asked = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId: items.gloves,
        batchNumber: nextBatch(),
        expiryDate: day(300),
        quantity: 9,
        reason: 'opening',
      }),
      201,
    );
    expect(
      errorOf(
        await post(
          `/inventory/adjustments/${asked.id}/reject`,
          { expectedVersion: 1, note: ' ' },
          { user: admin },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    const rejected = await ok<Adjustment>(
      post(
        `/inventory/adjustments/${asked.id}/reject`,
        { expectedVersion: 1, note: 'Count again' },
        { user: admin },
      ),
    );
    expect(rejected).toMatchObject({ status: 'rejected', rejectionNote: 'Count again', onHand: 0 });
    const list = await ok<Page<Adjustment>>(get('/inventory/adjustments?status=rejected'));
    expect(list.items.map((each) => each.id)).toContain(asked.id);
    expect(
      (await ok<Page<Adjustment>>(get('/inventory/adjustments'))).items.map((each) => each.id),
    ).not.toContain(asked.id);
  });

  it('emits stock.low when an approval brings the hospital to the reorder level', async () => {
    const drugId = await addDrug(hospital, 'Paracetamol', 'medicine', 50);
    const opened = await opening(60, { drugId });
    expect((await itemOf(drugId)).low).toBe(false);
    const take = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId,
        batchId: opened.batchId,
        quantity: -15,
        reason: 'damaged',
      }),
      201,
    );
    await ok(approve(take));
    expect(await itemOf(drugId)).toMatchObject({ low: true, hospitalOnHand: 45, reorderLevel: 50 });
    expect((await events(drugId)).map((each) => each.event)).toEqual(['stock.low']);
    // Already low: another one does not tell again.
    const more = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId,
        batchId: opened.batchId,
        quantity: -5,
        reason: 'damaged',
      }),
      201,
    );
    await ok(approve(more));
    expect((await events(drugId)).map((each) => each.event)).toEqual(['stock.low']);
  });

  it('needs stock:adjust to ask and stock:approve to decide', async () => {
    const body = {
      locationId: places.store,
      drugId: items.gloves,
      batchNumber: nextBatch(),
      expiryDate: day(90),
      quantity: 1,
      reason: 'opening',
    };
    expect(errorOf(await ask(body, { user: pharmacist }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await ask(body, { user: doctor }))).toEqual([403, 'permission_denied']);
    const asked = await ok<Adjustment>(ask(body, { user: admin }), 201);
    expect(errorOf(await approve(asked, { user: pharmacist }))).toEqual([403, 'permission_denied']);
    // The store keeper approves what the admin asked for.
    expect(await ok<Adjustment>(approve(asked, { user: keeper }))).toMatchObject({
      status: 'approved',
    });
    expect((await get('/inventory/stock', { user: pharmacist })).statusCode).toBe(200);
    expect(errorOf(await get('/inventory/stock', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
  });
});

describe('stock and alerts', () => {
  it('lists an item by batch and place, soonest expiry first, and counts the alerts', async () => {
    const drugId = await addDrug(hospital, 'Cetirizine', 'medicine', 10);
    const soon = await opening(4, { drugId, expiryDays: 20 });
    const later = await opening(6, { drugId, locationId: places.pharmacy, expiryDays: 700 });
    const item = await itemOf(drugId);
    expect(item).toMatchObject({ onHand: 10, hospitalOnHand: 10, low: true });
    expect(item?.batches.map((b) => [b.batchNumber, b.onHand, b.expiry])).toEqual([
      [soon.batchNumber, 4, 'expiring'],
      [later.batchNumber, 6, 'ok'],
    ]);
    // At the pharmacy: its batch only, the hospital's sum beside it.
    expect(await itemOf(drugId, `locationId=${places.pharmacy}`)).toMatchObject({
      onHand: 6,
      hospitalOnHand: 10,
    });
    // A window of 10 days does not reach the batch that expires in 20.
    expect((await itemOf(drugId, 'expiringWithinDays=10'))?.batches[0]?.expiry).toBe('ok');

    expect((await stock('alert=expiring')).items.map((each) => each.item.drugId)).toContain(drugId);
    expect(
      (await stock(`alert=expiring&locationId=${places.pharmacy}`)).items.map(
        (each) => each.item.drugId,
      ),
    ).not.toContain(drugId);
    expect((await stock('alert=low')).items.map((each) => each.item.drugId)).toContain(drugId);
    const counts = await ok<{ low: number; expiring: number; expired: number }>(
      get('/inventory/stock/alerts'),
    );
    expect(counts.low).toBeGreaterThanOrEqual(1);
    expect(counts.expiring).toBeGreaterThanOrEqual(1);
  });

  it('marks a batch past its expiry date as expired', async () => {
    const drugId = await addDrug(hospital, 'Azithromycin', 'medicine', null);
    const expired = await opening(2, { drugId, expiryDays: -3 });
    expect((await itemOf(drugId))?.batches[0]).toMatchObject({
      batchNumber: expired.batchNumber,
      expiry: 'expired',
    });
    expect((await stock('alert=expired')).items.map((each) => each.item.drugId)).toContain(drugId);
  });

  it('pages by name with a cursor, and refuses a cursor it did not make', async () => {
    const first = await ok<Page<StockItem>>(get('/inventory/stock?limit=1'));
    expect(first.total).toBeGreaterThan(1);
    const second = await ok<Page<StockItem>>(
      get(`/inventory/stock?limit=1&cursor=${first.nextCursor}`),
    );
    expect(second.items[0]?.item.drugId).not.toBe(first.items[0]?.item.drugId);
    expect(second.total).toBeUndefined();
    expect(errorOf(await get('/inventory/stock?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
    expect(errorOf(await get('/inventory/ledger?cursor=nonsense'))).toEqual([
      400,
      'invalid_cursor',
    ]);
    const ledger = await ok<Page<LedgerEntry>>(get('/inventory/ledger?limit=1'));
    const next = await ok<Page<LedgerEntry>>(
      get(`/inventory/ledger?limit=1&cursor=${ledger.nextCursor}`),
    );
    expect(next.items[0]?.id).not.toBe(ledger.items[0]?.id);
  });
});

describe('the hospital boundary', () => {
  it('never shows or moves another hospital’s stock', async () => {
    const opened = await opening(7);
    const clinicStock = await stock('', { tenant: clinic, user: clinicKeeper });
    expect(clinicStock.items.map((each) => each.item.drugId)).toEqual([items.clinicAmox]);
    expect(clinicStock.items[0]?.hospitalOnHand).toBe(0);
    expect(
      (
        await ok<Page<LedgerEntry>>(
          get('/inventory/ledger', { tenant: clinic, user: clinicKeeper }),
        )
      ).items,
    ).toEqual([]);
    // Naming the hospital's place, item or batch from the clinic finds nothing.
    expect(
      errorOf(
        await ask(
          {
            locationId: places.store,
            drugId: items.clinicAmox,
            batchNumber: nextBatch(),
            expiryDate: day(90),
            quantity: 1,
            reason: 'opening',
          },
          { tenant: clinic, user: clinicKeeper },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await ask(
          {
            locationId: places.clinicStore,
            drugId: items.amox,
            batchNumber: nextBatch(),
            expiryDate: day(90),
            quantity: 1,
            reason: 'opening',
          },
          { tenant: clinic, user: clinicKeeper },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await ask(
          {
            locationId: places.clinicStore,
            drugId: items.clinicAmox,
            batchId: opened.batchId,
            quantity: 1,
            reason: 'other',
          },
          { tenant: clinic, user: clinicKeeper },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(errorOf(await approve(opened, { tenant: clinic }))).toEqual([
      404,
      'adjustment_not_found',
    ]);
    expect(
      errorOf(
        await send(
          'PATCH',
          `/inventory/locations/${places.store}`,
          { expectedVersion: 1, name: 'Mine' },
          { tenant: clinic, user: admin },
        ),
      ),
    ).toEqual([404, 'location_not_found']);
  });

  it('keeps every table to its hospital under the app role', async () => {
    for (const table of [
      'stock_locations',
      'stock_batches',
      'stock_balances',
      'stock_ledger',
      'stock_adjustments',
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
        client.query(
          `insert into stock_locations (tenant_id, name, kind) values ($1, 'Stolen', 'store')`,
          [hospital.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('is closed when the hospital has inventory switched off', async () => {
    expect(errorOf(await get('/inventory/stock', { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the database', () => {
  it('moves stock only through the ledger, which never changes', async () => {
    const opened = await opening(5);
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('update stock_balances set on_hand = 500 where batch_id = $1', [
          opened.batchId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('update stock_ledger set quantity = 1')).rejects.toMatchObject({
        code: '42501',
      });
    });
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(client.query('delete from stock_ledger')).rejects.toMatchObject({
        code: '42501',
      });
    });
    // Not even the owner changes an entry.
    await expect(
      pool.query('update stock_ledger set quantity = 1 where batch_id = $1', [opened.batchId]),
    ).rejects.toThrow('never changes');
  });

  it('refuses a decided adjustment being changed, and one person deciding their own', async () => {
    const asked = await ok<Adjustment>(
      ask({
        locationId: places.store,
        drugId: items.gloves,
        batchNumber: nextBatch(),
        expiryDate: day(90),
        quantity: 1,
        reason: 'opening',
      }),
      201,
    );
    await expect(
      pool.query(
        `update stock_adjustments set status = 'rejected', decided_by = requested_by, decided_at = now(),
           rejection_note = 'x' where id = $1`,
        [asked.id],
      ),
    ).rejects.toMatchObject({ constraint: 'stock_adjustments_two_people' });
    const rejected = await ok<Adjustment>(
      post(
        `/inventory/adjustments/${asked.id}/reject`,
        { expectedVersion: 1, note: 'No' },
        { user: admin },
      ),
    );
    await expect(
      pool.query("update stock_adjustments set rejection_note = 'Yes' where id = $1", [
        rejected.id,
      ]),
    ).rejects.toThrow('never changes');
  });
});
