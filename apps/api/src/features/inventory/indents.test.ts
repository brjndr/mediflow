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
 * Indents and issue vouchers (#105) through the real app and database: a ward asks the store, a
 * second person approves, the store issues on vouchers that move stock out of the store and into
 * the ward through the ledger, and every indent reconciles with what was issued. The hospital
 * boundary, permissions, audit, events and the database's own rules.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let keeper: TestUser;
let nurse: TestUser;
let doctor: TestUser;
const items = { amox: '', gloves: '' };
const places = { store: '', ward: '', archived: '' };

interface IndentLine {
  id: string;
  item: { drugId: string };
  requestedQuantity: number;
  approvedQuantity?: number;
  issuedQuantity: number;
  storeOnHand?: number;
  batches?: { batchId: string; batchNumber: string; expiryDate: string; onHand: number }[];
}
interface Indent {
  id: string;
  reference: string;
  status: string;
  fromLocationName: string;
  toLocationName: string;
  requestedByName: string;
  decidedByName?: string;
  rejectionNote?: string;
  endedByName?: string;
  endNote?: string;
  lines: IndentLine[];
  issues: {
    id: string;
    reference: string;
    lines: { indentLineId: string; batchId: string; quantity: number }[];
  }[];
  version: number;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
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
const post = (url: string, body: object, options: Options = {}) => {
  const { tenant = hospital, user = keeper } = options;
  return app.inject({
    method: 'POST',
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': randomUUID() },
    payload: body,
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

const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
let batchCount = 0;
const nextBatch = () => {
  batchCount += 1;
  return `IB${String(batchCount).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6)}`;
};

/** Opening stock of a new batch at a place, asked by the store keeper and approved by the admin. */
async function opening(
  drugId: string,
  quantity: number,
  expiryDays = 400,
  locationId = places.store,
) {
  const asked = await ok<{ id: string; version: number }>(
    post('/inventory/adjustments', {
      locationId,
      drugId,
      batchNumber: nextBatch(),
      expiryDate: day(expiryDays),
      quantity,
      reason: 'opening',
    }),
    201,
  );
  const approved = await ok<{ batchId: string }>(
    post(
      `/inventory/adjustments/${asked.id}/approve`,
      { expectedVersion: asked.version },
      { user: admin },
    ),
  );
  return approved.batchId;
}

const onHandAt = async (batchId: string, locationId: string) =>
  (
    await pool.query<{ on_hand: number }>(
      'select on_hand from stock_balances where batch_id = $1 and location_id = $2',
      [batchId, locationId],
    )
  ).rows[0]?.on_hand ?? 0;

/** A new indent of the ward, asked by the nurse. */
const indent = (lines: { drugId: string; quantity: number }[], options: Options = {}) =>
  ok<Indent>(
    post(
      '/inventory/indents',
      { fromLocationId: places.ward, toLocationId: places.store, note: 'Night stock', lines },
      { user: nurse, ...options },
    ),
    201,
  );
const approve = (found: Indent, quantities: number[], options: Options = {}) =>
  post(
    `/inventory/indents/${found.id}/approve`,
    {
      expectedVersion: found.version,
      lines: found.lines.map((line, index) => ({ lineId: line.id, quantity: quantities[index] })),
    },
    options,
  );
const issue = (
  found: Indent,
  lines: { indentLineId: string; batchId: string; quantity: number }[],
  options: Options = {},
) =>
  post(`/inventory/indents/${found.id}/issues`, { expectedVersion: found.version, lines }, options);

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

async function addDrug(tenant: TestTenant, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into drugs (tenant_id, type, generic_name, form, unit, schedule, tax_class)
     values ($1, 'medicine', $2, 'tablet', 'piece', 'none', 'standard') returning id`,
    [tenant.id, name],
  );
  return rows[0]?.id ?? '';
}

async function addPlace(tenant: TestTenant, name: string, kind: string) {
  return (
    await ok<{ id: string }>(
      post('/inventory/locations', { name, kind }, { tenant, user: admin }),
      201,
    )
  ).id;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { drugs: true, inventory: true };
  hospital = await createTenant(pool, 'Indent Hospital', { features });
  clinic = await createTenant(pool, 'Indent Clinic', { features });
  closed = await createTenant(pool, 'Indent Closed', {
    features: { ...features, inventory: false },
  });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Indent Admin');
  keeper = await user('Indent Keeper');
  nurse = await user('Ward Nurse');
  doctor = await user('Indent Doctor');
  for (const tenant of [hospital, clinic, closed])
    await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, keeper, hospital, 'store_keeper');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, doctor, hospital, 'doctor');
  items.amox = await addDrug(hospital, 'Amoxicillin');
  items.gloves = await addDrug(hospital, 'Paracetamol');
  places.store = await addPlace(hospital, 'Main store', 'store');
  places.ward = await addPlace(hospital, 'Ward 2', 'ward');
  places.archived = await addPlace(hospital, 'Old theatre', 'department');
  await ok(post(`/inventory/locations/${places.archived}/archive`, {}, { user: admin }));
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The ledger, the balances and the vouchers refuse removal to everyone: the triggers are off.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'stock_issue_lines',
      'stock_issues',
      'stock_indent_lines',
      'stock_indents',
      'inventory_counters',
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
  await deleteUsers(pool, [admin, keeper, nurse, doctor]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('an indent', () => {
  it('is asked by a ward, approved by someone else, issued on vouchers and reconciles', async () => {
    const soon = await opening(items.amox, 30, 200);
    const later = await opening(items.amox, 50, 400);
    const asked = await indent([
      { drugId: items.amox, quantity: 60 },
      { drugId: items.gloves, quantity: 10 },
    ]);
    expect(asked).toMatchObject({
      reference: expect.stringMatching(/^IND-\d{6}$/),
      status: 'requested',
      fromLocationName: 'Ward 2',
      toLocationName: 'Main store',
      requestedByName: 'Ward Nurse',
    });
    // The nurse sees neither the store's stock nor its batches: those are the store's.
    expect(asked.lines.map((line) => [line.requestedQuantity, line.storeOnHand])).toEqual([
      [60, undefined],
      [10, undefined],
    ]);
    expect(asked.lines[0]?.batches).toBeUndefined();
    const forKeeper = await ok<Indent>(get(`/inventory/indents/${asked.id}`));
    expect(forKeeper.lines.map((line) => line.storeOnHand)).toEqual([80, 0]);

    // Nobody approves an indent they asked for; a nurse cannot approve at all.
    expect(errorOf(await approve(asked, [40, 0], { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await approve(asked, [61, 0]))).toEqual([400, 'validation_failed']);
    expect(errorOf(await approve(asked, [0, 0]))).toEqual([400, 'validation_failed']);
    const approved = await ok<Indent>(approve(asked, [40, 0]));
    expect(approved).toMatchObject({ status: 'approved', decidedByName: 'Indent Keeper' });
    // Nearest expiry first, for the store keeper.
    expect(approved.lines[0]?.batches?.map((batch) => [batch.batchId, batch.onHand])).toEqual([
      [soon, 30],
      [later, 50],
    ]);
    expect(errorOf(await approve(approved, [40, 0], { user: admin }))).toEqual([
      409,
      'indent_decided',
    ]);
    expect(errorOf(await approve(asked, [40, 0], { user: admin }))).toEqual([409, 'conflict']);

    const line = approved.lines[0]?.id ?? '';
    const other = approved.lines[1]?.id ?? '';
    expect(
      errorOf(await issue(approved, [{ indentLineId: line, batchId: soon, quantity: 41 }])),
    ).toEqual([409, 'over_issue']);
    expect(
      errorOf(await issue(approved, [{ indentLineId: other, batchId: soon, quantity: 1 }])),
    ).toEqual([409, 'over_issue']);
    expect(
      errorOf(await issue(approved, [{ indentLineId: line, batchId: soon, quantity: 31 }])),
    ).toEqual([409, 'insufficient_stock']);

    const partly = await ok<Indent>(
      issue(approved, [{ indentLineId: line, batchId: soon, quantity: 25 }]),
      201,
    );
    expect(partly.status).toBe('partly_issued');
    expect(partly.issues[0]?.reference).toMatch(/^IV-\d{6}$/);
    const issued = await ok<Indent>(
      issue(partly, [
        { indentLineId: line, batchId: soon, quantity: 5 },
        { indentLineId: line, batchId: later, quantity: 10 },
      ]),
      201,
    );
    expect(issued.status).toBe('issued');
    expect(issued.lines.map((each) => [each.approvedQuantity, each.issuedQuantity])).toEqual([
      [40, 40],
      [0, 0],
    ]);
    // The indent reconciles with its vouchers, and they with the ledger.
    const onVouchers = issued.issues.flatMap((voucher) => voucher.lines);
    expect(onVouchers.reduce((sum, each) => sum + each.quantity, 0)).toBe(40);
    const ledger = await pool.query<{ reason: string; location_id: string; total: number }>(
      `select reason, location_id, sum(quantity)::int as total from stock_ledger
       where source = 'issue' and source_id = any($1) group by reason, location_id order by reason`,
      [issued.issues.map((voucher) => voucher.id)],
    );
    expect(ledger.rows).toEqual([
      { reason: 'issue_in', location_id: places.ward, total: 40 },
      { reason: 'issue_out', location_id: places.store, total: -40 },
    ]);
    expect([await onHandAt(soon, places.store), await onHandAt(soon, places.ward)]).toEqual([
      0, 30,
    ]);
    expect([await onHandAt(later, places.store), await onHandAt(later, places.ward)]).toEqual([
      40, 10,
    ]);
    expect(
      errorOf(await issue(issued, [{ indentLineId: line, batchId: later, quantity: 1 }])),
    ).toEqual([409, 'indent_not_open']);

    expect(await audited('stock_indent', asked.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
    ]);
    const events = await pool.query<{ event: string; payload: Record<string, unknown> }>(
      `select event, payload from outbox where tenant_id = $1 and event = 'stock.issued'
       and payload->>'indentId' = $2`,
      [hospital.id, asked.id],
    );
    expect(events.rows).toHaveLength(2);
    expect(Object.keys(events.rows[0]?.payload ?? {}).sort()).toEqual([
      'fromLocationId',
      'indentId',
      'issueId',
      'toLocationId',
    ]);
  });

  it('refuses the asker deciding it, and is rejected, withdrawn or closed short', async () => {
    await opening(items.gloves, 20);
    const own = await indent([{ drugId: items.gloves, quantity: 5 }], { user: keeper });
    expect(errorOf(await approve(own, [5], { user: keeper }))).toEqual([409, 'own_indent']);

    const toReject = await indent([{ drugId: items.gloves, quantity: 5 }]);
    expect(
      errorOf(
        await post(
          `/inventory/indents/${toReject.id}/reject`,
          { expectedVersion: toReject.version, note: '   ' },
          { user: admin },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    const rejected = await ok<Indent>(
      post(
        `/inventory/indents/${toReject.id}/reject`,
        { expectedVersion: toReject.version, note: 'Ask next week' },
        { user: admin },
      ),
    );
    expect(rejected).toMatchObject({ status: 'rejected', rejectionNote: 'Ask next week' });

    const toCancel = await indent([{ drugId: items.gloves, quantity: 5 }]);
    expect(
      errorOf(
        await post(`/inventory/indents/${toCancel.id}/cancel`, {
          expectedVersion: toCancel.version,
        }),
      ),
    ).toEqual([409, 'not_requester']);
    const cancelled = await ok<Indent>(
      post(
        `/inventory/indents/${toCancel.id}/cancel`,
        { expectedVersion: toCancel.version },
        { user: nurse },
      ),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', endedByName: 'Ward Nurse' });
    expect(errorOf(await approve(cancelled, [5]))).toEqual([409, 'indent_decided']);

    const toClose = await indent([{ drugId: items.gloves, quantity: 5 }]);
    const open = await ok<Indent>(approve(toClose, [5]));
    const closedShort = await ok<Indent>(
      post(`/inventory/indents/${open.id}/close`, {
        expectedVersion: open.version,
        note: 'Out of stock',
      }),
    );
    expect(closedShort).toMatchObject({ status: 'closed', endNote: 'Out of stock' });
    expect(closedShort.lines[0]?.batches).toBeUndefined();
  });

  it('checks the places and items it asks for', async () => {
    const asks = (body: object) => post('/inventory/indents', body, { user: nurse });
    const lines = [{ drugId: items.gloves, quantity: 1 }];
    expect(
      errorOf(await asks({ fromLocationId: places.store, toLocationId: places.store, lines })),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await asks({ fromLocationId: places.archived, toLocationId: places.store, lines })),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await asks({
          fromLocationId: places.ward,
          toLocationId: places.store,
          lines: [...lines, ...lines],
        }),
      ),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(
        await asks({
          fromLocationId: places.ward,
          toLocationId: places.store,
          lines: [{ drugId: randomUUID(), quantity: 1 }],
        }),
      ),
    ).toEqual([400, 'validation_failed']);
  });

  it('issues the last units once when two vouchers race', async () => {
    const batch = await opening(items.amox, 4, 300);
    const first = await ok<Indent>(
      approve(await indent([{ drugId: items.amox, quantity: 4 }]), [4]),
    );
    const second = await ok<Indent>(
      approve(await indent([{ drugId: items.amox, quantity: 4 }]), [4]),
    );
    const results = await Promise.all(
      [first, second].map((each) =>
        issue(each, [{ indentLineId: each.lines[0]?.id ?? '', batchId: batch, quantity: 4 }]),
      ),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(await onHandAt(batch, places.store)).toBe(0);
  });

  it('lists indents newest first, by status and place, for a nurse with no stock access', async () => {
    const page = await ok<Page<{ id: string; status: string }>>(
      get(`/inventory/indents?status=issued&locationId=${places.ward}`, { user: nurse }),
    );
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items.every((each) => each.status === 'issued')).toBe(true);
    expect(errorOf(await get('/inventory/stock', { user: nurse }))).toEqual([
      403,
      'permission_denied',
    ]);
    const placesPage = await ok<Page<{ name: string }>>(
      get('/inventory/indent-places', { user: nurse }),
    );
    expect(placesPage.items.map((place) => place.name)).toEqual(['Main store', 'Ward 2']);
    expect(errorOf(await get('/inventory/indents', { user: doctor }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(
      (await ok<Page<unknown>>(get('/inventory/indents?locationId=not-a-uuid', { user: nurse })))
        .items,
    ).toEqual([]);
  });
});

describe('refusals', () => {
  /** An indent of the ward for `quantity` units of the item, approved for all of them. */
  const approvedIndent = async (drugId: string, quantity: number) =>
    ok<Indent>(approve(await indent([{ drugId, quantity }]), [quantity]));

  it('replays a voucher sent twice with one key, moving the stock once', async () => {
    const batch = await opening(items.gloves, 10, 300);
    const open = await approvedIndent(items.gloves, 6);
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/inventory/indents/${open.id}/issues`,
        headers: { ...as(hospital.id, keeper.id), 'idempotency-key': `issue-${open.id}` },
        payload: {
          expectedVersion: open.version,
          lines: [{ indentLineId: open.lines[0]?.id, batchId: batch, quantity: 6 }],
        },
      });
    const first = await send();
    const again = await send();
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Indent>().issues).toEqual(first.json<Indent>().issues);
    expect([await onHandAt(batch, places.store), await onHandAt(batch, places.ward)]).toEqual([
      4, 6,
    ]);
  });

  it('issues one of two vouchers sent at once for the same indent', async () => {
    const batch = await opening(items.gloves, 10, 300);
    const open = await approvedIndent(items.gloves, 4);
    const line = open.lines[0]?.id ?? '';
    const results = await Promise.all(
      [1, 2].map(() => issue(open, [{ indentLineId: line, batchId: batch, quantity: 2 }])),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(errorOf(results.find((result) => result.statusCode === 409) as Reply)).toEqual([
      409,
      'conflict',
    ]);
    expect(await onHandAt(batch, places.ward)).toBe(2);
  });

  it('never issues an expired batch, nor to or from a place archived since', async () => {
    const expired = await opening(items.gloves, 5, -3);
    const open = await approvedIndent(items.gloves, 2);
    const line = open.lines[0]?.id ?? '';
    expect(open.lines[0]?.batches?.map((each) => each.batchId)).not.toContain(expired);
    expect(
      errorOf(await issue(open, [{ indentLineId: line, batchId: expired, quantity: 1 }])),
    ).toEqual([409, 'batch_expired']);

    const shelf = (
      await ok<{ id: string }>(
        post(
          '/inventory/locations',
          { name: 'Recovery shelf', kind: 'department' },
          { user: admin },
        ),
        201,
      )
    ).id;
    const fresh = await opening(items.gloves, 5, 300);
    const asked = await ok<Indent>(
      post(
        '/inventory/indents',
        {
          fromLocationId: shelf,
          toLocationId: places.store,
          lines: [{ drugId: items.gloves, quantity: 1 }],
        },
        { user: nurse },
      ),
      201,
    );
    const approved = await ok<Indent>(approve(asked, [1]));
    await ok(post(`/inventory/locations/${shelf}/archive`, {}, { user: admin }));
    expect(
      errorOf(
        await issue(approved, [
          { indentLineId: approved.lines[0]?.id ?? '', batchId: fresh, quantity: 1 },
        ]),
      ),
    ).toEqual([422, 'unknown_location']);
  });

  it('asks only a store, and takes each step only in its turn', async () => {
    const lines = [{ drugId: items.gloves, quantity: 1 }];
    expect(
      errorOf(
        await post(
          '/inventory/indents',
          { fromLocationId: places.store, toLocationId: places.ward, lines },
          { user: nurse },
        ),
      ),
    ).toEqual([400, 'validation_failed']);
    const open = await approvedIndent(items.gloves, 1);
    expect(
      errorOf(
        await post(
          `/inventory/indents/${open.id}/cancel`,
          { expectedVersion: open.version },
          { user: nurse },
        ),
      ),
    ).toEqual([409, 'indent_decided']);
    const closed = await ok<Indent>(
      post(`/inventory/indents/${open.id}/close`, {
        expectedVersion: open.version,
        note: 'Not needed',
      }),
    );
    expect(
      errorOf(
        await issue(closed, [
          { indentLineId: closed.lines[0]?.id ?? '', batchId: randomUUID(), quantity: 1 },
        ]),
      ),
    ).toEqual([409, 'indent_not_open']);
  });

  it('refuses a nurse approving or issuing, and another hospital every step', async () => {
    const asked = await indent([{ drugId: items.gloves, quantity: 1 }]);
    const open = await approvedIndent(items.gloves, 1);
    const line = open.lines[0]?.id ?? '';
    expect(errorOf(await approve(asked, [1], { user: nurse }))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(
        await issue(open, [{ indentLineId: line, batchId: randomUUID(), quantity: 1 }], {
          user: nurse,
        }),
      ),
    ).toEqual([403, 'permission_denied']);
    const elsewhere = { tenant: clinic, user: admin };
    expect(errorOf(await approve(asked, [1], elsewhere))).toEqual([404, 'indent_not_found']);
    expect(
      errorOf(
        await issue(open, [{ indentLineId: line, batchId: randomUUID(), quantity: 1 }], elsewhere),
      ),
    ).toEqual([404, 'indent_not_found']);
    expect(
      errorOf(
        await post(
          `/inventory/indents/${open.id}/close`,
          { expectedVersion: open.version, note: 'x' },
          elsewhere,
        ),
      ),
    ).toEqual([404, 'indent_not_found']);
  });
});

describe('the hospital boundary', () => {
  it('keeps indents and vouchers to their hospital', async () => {
    const mine = await indent([{ drugId: items.gloves, quantity: 1 }]);
    expect(
      errorOf(await get(`/inventory/indents/${mine.id}`, { tenant: clinic, user: admin })),
    ).toEqual([404, 'indent_not_found']);
    expect(
      (await ok<Page<unknown>>(get('/inventory/indents', { tenant: clinic, user: admin }))).items,
    ).toEqual([]);
    for (const table of [
      'stock_indents',
      'stock_indent_lines',
      'stock_issues',
      'stock_issue_lines',
      'inventory_counters',
    ]) {
      const seen = await asTenantSql(pool, clinic.id, async (client) =>
        (
          await client.query<{ tenant_id: string }>(`select distinct tenant_id from ${table}`)
        ).rows.map((row) => row.tenant_id),
      );
      expect([table, seen.filter((id) => id !== clinic.id)]).toEqual([table, []]);
    }
    expect(errorOf(await get('/inventory/indents', { tenant: closed, user: admin }))).toEqual([
      403,
      'feature_disabled',
    ]);
  });
});

describe('the database', () => {
  it('moves issued units only with a voucher line, and never changes a voucher', async () => {
    const found = await indent([{ drugId: items.gloves, quantity: 2 }]);
    const lineId = found.lines[0]?.id ?? '';
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('update stock_indent_lines set issued_quantity = 1 where id = $1', [lineId]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await expect(
      pool.query(
        `update stock_indents set status = 'approved', decided_by = requested_by, decided_at = now()
         where id = $1`,
        [found.id],
      ),
    ).rejects.toMatchObject({ constraint: 'stock_indents_two_people' });
    await expect(pool.query('update stock_issue_lines set quantity = 1')).rejects.toThrow(
      'never changed',
    );
    await expect(pool.query('truncate stock_issues cascade')).rejects.toThrow('never emptied');
  });

  it('takes a voucher line only with its own entries, and only on an open indent', async () => {
    const batch = await opening(items.gloves, 4, 300);
    const open = await ok<Indent>(
      approve(await indent([{ drugId: items.gloves, quantity: 2 }]), [2]),
    );
    const partly = await ok<Indent>(
      issue(open, [{ indentLineId: open.lines[0]?.id ?? '', batchId: batch, quantity: 1 }]),
      201,
    );
    const voucher = partly.issues[0]?.id ?? '';
    const line = partly.lines[0]?.id ?? '';
    // An adjustment's entry of the same batch is not this voucher's.
    const { rows } = await pool.query<{ id: string }>(
      `select id from stock_ledger where batch_id = $1 and source = 'adjustment'`,
      [batch],
    );
    const insert = () =>
      pool.query(
        `insert into stock_issue_lines (tenant_id, issue_id, indent_id, indent_line_id, drug_id, batch_id,
           quantity, out_entry_id, in_entry_id)
         values ($1, $2, $3, $4, $5, $6, 1, $7, $8)`,
        [hospital.id, voucher, open.id, line, items.gloves, batch, rows[0]?.id, randomUUID()],
      );
    await expect(insert()).rejects.toThrow('names its own entries');
    await ok(
      post(`/inventory/indents/${open.id}/close`, {
        expectedVersion: partly.version,
        note: 'Enough',
      }),
    );
    await expect(insert()).rejects.toThrow('only on an approved indent');
  });
});
