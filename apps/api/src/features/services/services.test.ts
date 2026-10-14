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
 * The services and prices API through the real app and database: the search and its paging,
 * adding, changing with a version, archiving, prices with effective dates, the hospital
 * boundary, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the services module switched off. */
let closed: TestTenant;
/** A hospital whose calendar date is ahead of most of the world's. */
let ahead: TestTenant;
let admin: TestUser;
/** Sees services, cannot change them. */
let doctor: TestUser;
/** No service permissions at all. */
let storeKeeper: TestUser;

const AHEAD_ZONE = 'Pacific/Kiritimati';

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Price {
  id: string;
  serviceId: string;
  priceListId: string;
  amountMinor: number;
  effectiveFrom: string;
  effectiveTo?: string;
}
interface Service {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  category: string;
  taxClass: string;
  description?: string;
  archived: boolean;
  version: number;
  currentPrice?: Price;
}
interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total?: number;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const post = (url: string, body: object | undefined, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers(options),
    ...(body ? { payload: body } : {}),
  });
const search = (body: object = {}, options: Options = {}) =>
  post('/services/search', body, options);
const add = (body: object, options: Options = {}) => post('/services', body, options);
const read = (id: string, options: Options = {}) =>
  app.inject({ url: `/services/${id}`, headers: headers(options) });
const change = (id: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PATCH', url: `/services/${id}`, headers: headers(options), payload: body });
const act = (id: string, action: 'archive' | 'restore', options: Options = {}) =>
  post(`/services/${id}/${action}`, undefined, options);
const prices = (id: string, query = '', options: Options = {}) =>
  app.inject({ url: `/services/${id}/prices${query}`, headers: headers(options) });
const setPrice = (id: string, body: object, options: Options = {}) =>
  post(`/services/${id}/prices`, body, options);
const withdraw = (id: string, priceId: string, options: Options = {}) =>
  app.inject({
    method: 'DELETE',
    url: `/services/${id}/prices/${priceId}`,
    headers: headers(options),
  });

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
const names = (response: Response) => response.json<Page<Service>>().items.map((item) => item.name);

/** The calendar date where a hospital is, and days from it. */
const dateIn = (timeZone: string, daysFromToday = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const day = new Date(`${today}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + daysFromToday);
  return day.toISOString().slice(0, 10);
};
const day = (daysFromToday = 0) => dateIn('Asia/Kolkata', daysFromToday);

let codes = 0;
/** A code no other test uses. */
const code = (prefix = 'T') => `${prefix}-${String(++codes).padStart(4, '0')}`;

/** Adds a service and returns it. */
async function added(name: string, options: Options = {}, more: object = {}) {
  const response = await add(
    { code: code(), name, category: 'consultation', taxClass: 'exempt', ...more },
    options,
  );
  if (response.statusCode !== 201) throw new Error(`could not add ${name} in test setup`);
  return response.json<Service>();
}

/** The standard price list of a hospital. */
async function standardList(tenant: TestTenant): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from price_lists where tenant_id = $1 and standard',
    [tenant.id],
  );
  if (!rows[0]) throw new Error('the hospital has no standard price list');
  return rows[0].id;
}

/** A price that has been in force since some time ago, put there as history is: not by a request. */
async function pricedSince(service: Service, from: string, amountMinor: number) {
  const tenant = [hospital, clinic, ahead].find((candidate) => candidate.id === service.tenantId);
  if (!tenant) throw new Error('unknown hospital');
  await pool.query(
    `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
     values ($1, $2, $3, $4, $5::date)`,
    [tenant.id, service.id, await standardList(tenant), amountMinor, from],
  );
}

const audited = async (tenant: TestTenant, entity: string, entityId: string) => {
  const { rows } = await pool.query<{ action: string }>(
    `select action from audit_log
     where tenant_id = $1 and entity = $2 and entity_id = $3 order by at`,
    [tenant.id, entity, entityId],
  );
  return rows.map((row) => row.action);
};

const events = async (tenant: TestTenant, entityId: string) => {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from outbox
     where tenant_id = $1 and event = 'master.changed' and entity_id = $2 order by occurred_at, id`,
    [tenant.id, entityId],
  );
  return rows.map((row) => row.payload);
};

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Services Hospital', { features: { services: true } });
  clinic = await createTenant(pool, 'Services Clinic', { features: { services: true } });
  closed = await createTenant(pool, 'Services Closed', { features: { services: false } });
  ahead = await createTenant(pool, 'Services Ahead', {
    features: { services: true },
    timezone: AHEAD_ZONE,
  });
  const tenants = [hospital, clinic, closed, ahead];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Services Admin', { withPassword: false });
  doctor = await createUser(pool, 'Services Doctor', { withPassword: false });
  storeKeeper = await createUser(pool, 'Services Storekeeper', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
});

afterAll(async () => {
  const ids = [hospital, clinic, closed, ahead].filter(Boolean).map((tenant) => tenant.id);
  try {
    // Services have no ON DELETE CASCADE from tenants, so the test rows go first.
    await pool.query('delete from service_prices where tenant_id = any($1::uuid[])', [ids]);
    await pool.query('delete from services where tenant_id = any($1::uuid[])', [ids]);
    await deleteUsers(pool, [admin, doctor, storeKeeper].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed, ahead].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('a hospital', () => {
  it('has one standard price list from the day it is created', async () => {
    const response = await app.inject({ url: '/price-lists', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: await standardList(hospital), name: 'Standard', standard: true }],
    });
  });
});

describe('adding a service', () => {
  it('adds it to the session’s hospital, trimmed, and records who did', async () => {
    const response = await add({
      code: 'CON-001',
      name: '  General consultation  ',
      category: 'consultation',
      taxClass: 'exempt',
      description: '  First visit  ',
    });
    expect(response.statusCode).toBe(201);
    const service = response.json<Service>();
    expect(service).toMatchObject({
      tenantId: hospital.id,
      code: 'CON-001',
      name: 'General consultation',
      category: 'consultation',
      taxClass: 'exempt',
      description: 'First visit',
      archived: false,
      version: 1,
    });
    expect(service.currentPrice).toBeUndefined();
    expect(await audited(hospital, 'service', service.id)).toEqual(['create']);
    expect(await events(hospital, service.id)).toEqual([{ kind: 'service', change: 'created' }]);
  });

  it('gives it a price on the standard list from today when one is sent', async () => {
    const service = await added('Priced From The Start', {}, { priceMinor: 50000 });
    expect(service.currentPrice).toMatchObject({
      serviceId: service.id,
      priceListId: await standardList(hospital),
      amountMinor: 50000,
      effectiveFrom: day(),
    });
    expect(service.currentPrice?.effectiveTo).toBeUndefined();
  });

  it('counts today where the hospital is, not where the server is', async () => {
    const service = await added('Priced Ahead', { tenant: ahead }, { priceMinor: 100 });
    expect(service.currentPrice?.effectiveFrom).toBe(dateIn(AHEAD_ZONE));
  });

  it('refuses a code the hospital already has, whatever its capitals, archived or not', async () => {
    const first = await added('Taken Code', {}, { code: 'DUP-1' });
    const again = { code: 'dup-1', name: 'Other', category: 'lab', taxClass: 'exempt' };
    expect(errorOf(await add(again))).toEqual([409, 'service_code_taken']);
    await act(first.id, 'archive');
    expect(errorOf(await add(again))).toEqual([409, 'service_code_taken']);
  });

  it('lets one of two simultaneous requests for a new code through', async () => {
    const body = { code: 'RACE-1', name: 'Race', category: 'lab', taxClass: 'exempt' };
    const results = await Promise.all([add(body), add(body)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('answers a repeat of the same request with the same service, and adds one', async () => {
    const body = { code: 'IDEM-1', name: 'Idempotent', category: 'lab', taxClass: 'exempt' };
    const key = `services-${randomUUID()}`;
    const first = await add(body, { key });
    const second = await add(body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(names(await search({ q: 'IDEM-1' }))).toEqual(['Idempotent']);
  });

  it('needs a code, a name, a category and a tax class it knows, and a sensible price', async () => {
    const good = { code: 'OK-1', name: 'Fine', category: 'lab', taxClass: 'exempt' };
    const bad: object[] = [
      { ...good, code: '' },
      { ...good, code: 'has space' },
      { ...good, code: '-starts-wrong' },
      { ...good, code: 'x'.repeat(31) },
      { ...good, name: '   ' },
      { ...good, name: 'x'.repeat(151) },
      { ...good, name: 'nul\u0000' },
      { ...good, category: 'surgery' },
      { ...good, taxClass: 'zero' },
      { ...good, description: 'x'.repeat(501) },
      { ...good, priceMinor: -1 },
      { ...good, priceMinor: 1.5 },
      { ...good, priceMinor: 1_000_000_000_001 },
      { code: 'OK-1', name: 'Fine' },
    ];
    for (const body of bad) {
      expect((await add(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(names(await search({ q: 'OK-1' }))).toEqual([]);
  });
});

describe('the search', () => {
  let fresh: TestTenant;

  beforeAll(async () => {
    // Its own hospital, so the other tests' services are not in the way.
    fresh = await createTenant(pool, 'Services Search', { features: { services: true } });
    await grantRoleDefaults(app, fresh);
    await addMembership(pool, admin, fresh, 'admin');
    const rows: [string, string, string][] = [
      ['LAB-001', 'complete blood count', 'lab'],
      ['LAB-002', 'Blood glucose fasting', 'lab'],
      ['IMG-001', 'Chest X-ray', 'imaging'],
      ['CON-001', 'antenatal visit', 'consultation'],
      ['CON-002', 'Zoster vaccine counselling', 'consultation'],
      ['PRO-100', '100% oxygen therapy', 'procedure'],
    ];
    for (const [serviceCode, name, category] of rows) {
      const response = await add(
        { code: serviceCode, name, category, taxClass: 'exempt' },
        { tenant: fresh },
      );
      if (response.statusCode !== 201) throw new Error(`could not add ${name}`);
    }
    const old = await add(
      { code: 'OLD-001', name: 'Old check', category: 'package', taxClass: 'standard' },
      { tenant: fresh },
    );
    await act(old.json<Service>().id, 'archive', { tenant: fresh });
  });

  afterAll(async () => {
    await pool.query('delete from services where tenant_id = $1', [fresh.id]);
    await deleteTenants(pool, [fresh]);
  });

  const find = (body: object = {}) => search(body, { tenant: fresh });

  it('is in name order whatever the capitals, a page at a time, with the total once', async () => {
    const first = await find({ limit: 4 });
    expect(first.statusCode).toBe(200);
    expect(names(first)).toEqual([
      '100% oxygen therapy',
      'antenatal visit',
      'Blood glucose fasting',
      'Chest X-ray',
    ]);
    const page = first.json<Page<Service>>();
    expect(page.total).toBe(6);
    expect(page.nextCursor).toEqual(expect.any(String));

    const second = await find({ limit: 4, cursor: page.nextCursor });
    expect(names(second)).toEqual(['complete blood count', 'Zoster vaccine counselling']);
    expect(second.json<Page<Service>>()).toMatchObject({ nextCursor: null });
    expect(second.json<Page<Service>>().total).toBeUndefined();
  });

  it('finds every word of what was typed in the code or the name, in any order', async () => {
    expect(names(await find({ q: 'blood' }))).toEqual([
      'Blood glucose fasting',
      'complete blood count',
    ]);
    expect(names(await find({ q: 'COUNT blood' }))).toEqual(['complete blood count']);
    expect(names(await find({ q: 'img-001' }))).toEqual(['Chest X-ray']);
    expect(names(await find({ q: 'lab glucose' }))).toEqual(['Blood glucose fasting']);
    expect(names(await find({ q: '   ' }))).toHaveLength(6);
    expect(names(await find({ q: 'nothing like it' }))).toEqual([]);
  });

  it('takes what was typed as text, not as a pattern', async () => {
    expect(names(await find({ q: '100%' }))).toEqual(['100% oxygen therapy']);
    expect(names(await find({ q: '%' }))).toEqual(['100% oxygen therapy']);
    expect(names(await find({ q: '_' }))).toEqual([]);
  });

  it('filters by category and counts what it filtered', async () => {
    const response = await find({ category: 'consultation' });
    expect(names(response)).toEqual(['antenatal visit', 'Zoster vaccine counselling']);
    expect(response.json<Page<Service>>().total).toBe(2);
  });

  it('shows the archived services only when asked', async () => {
    expect(names(await find({ archived: true }))).toEqual(['Old check']);
    expect(names(await find())).not.toContain('Old check');
  });

  it('refuses a cursor it did not make, and a search it does not understand', async () => {
    expect(errorOf(await find({ cursor: 'made-up' }))).toEqual([400, 'invalid_cursor']);
    expect((await find({ limit: 101 })).statusCode).toBe(400);
    expect((await find({ category: 'surgery' })).statusCode).toBe(400);
    expect((await find({ q: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});

describe('changing a service', () => {
  it('saves new details from the version that was read, and says which changed', async () => {
    const service = await added('Before', {}, { description: 'Old' });
    const response = await change(service.id, {
      name: ' After ',
      category: 'procedure',
      taxClass: 'standard',
      description: 'New',
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: service.id,
      code: service.code,
      name: 'After',
      category: 'procedure',
      taxClass: 'standard',
      description: 'New',
      version: 2,
    });
    expect(await audited(hospital, 'service', service.id)).toEqual(['create', 'update']);
    expect((await events(hospital, service.id)).at(-1)).toEqual({
      kind: 'service',
      change: 'updated',
      fields: ['name', 'category', 'taxClass', 'description'],
    });
  });

  it('refuses a change made from an older version, and changes nothing', async () => {
    const service = await added('Moved On');
    await change(service.id, { name: 'Moved On Once', expectedVersion: 1 });
    const stale = await change(service.id, { name: 'Too Late', expectedVersion: 1 });
    expect(errorOf(stale)).toEqual([409, 'conflict']);
    expect((await read(service.id)).json()).toMatchObject({ name: 'Moved On Once', version: 2 });
  });

  it('writes nothing when what is sent is what it already has', async () => {
    const service = await added('Same', {}, { description: 'As it was' });
    const response = await change(service.id, {
      name: 'Same',
      category: 'consultation',
      description: ' As it was ',
      expectedVersion: 1,
    });
    expect(response.json()).toMatchObject({ version: 1 });
    expect(await audited(hospital, 'service', service.id)).toEqual(['create']);
    expect(await events(hospital, service.id)).toHaveLength(1);
  });

  it('never changes the code, whatever is sent', async () => {
    const service = await added('Fixed Code');
    const response = await change(service.id, {
      code: 'NEW-CODE',
      name: 'Fixed Code Renamed',
      expectedVersion: 1,
    });
    expect(response.json()).toMatchObject({ code: service.code, name: 'Fixed Code Renamed' });
    await expect(
      pool.query("update services set code = 'FORCED' where id = $1", [service.id]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('lets one of two changes made from the same version through', async () => {
    const service = await added('Contested');
    const results = await Promise.all([
      change(service.id, { name: 'Contested A', expectedVersion: 1 }),
      change(service.id, { name: 'Contested B', expectedVersion: 1 }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('removes a description that is sent empty, and refuses what it cannot store', async () => {
    const service = await added('Described', {}, { description: 'Something' });
    const response = await change(service.id, { description: '  ', expectedVersion: 1 });
    expect(response.json<Service>().description).toBeUndefined();
    expect((await change(service.id, { name: '  ', expectedVersion: 2 })).statusCode).toBe(400);
    expect((await change(service.id, { name: 'No version' })).statusCode).toBe(400);
  });

  it('archives and restores, and doing either twice changes nothing', async () => {
    const service = await added('Comes And Goes');
    expect((await act(service.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(service.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(service.id, 'restore')).json()).toMatchObject({
      archived: false,
      version: 3,
    });
    expect((await act(service.id, 'restore')).json()).toMatchObject({ version: 3 });
    expect(await audited(hospital, 'service', service.id)).toEqual([
      'create',
      'archive',
      'restore',
    ]);
    expect((await events(hospital, service.id)).map((payload) => payload.change)).toEqual([
      'created',
      'archived',
      'restored',
    ]);
  });
});

describe('prices', () => {
  it('lets the first price start today or later, and not before', async () => {
    const service = await added('First Price');
    expect(
      errorOf(await setPrice(service.id, { amountMinor: 100, effectiveFrom: day(-1) })),
    ).toEqual([400, 'validation_failed']);
    const response = await setPrice(service.id, { amountMinor: 100, effectiveFrom: day() });
    expect(response.statusCode).toBe(201);
    const price = response.json<Price>();
    expect(price).toEqual({
      id: price.id,
      serviceId: service.id,
      priceListId: await standardList(hospital),
      amountMinor: 100,
      effectiveFrom: day(),
    });
    expect((await read(service.id)).json<Service>().currentPrice).toEqual(price);
    expect(await audited(hospital, 'service_price', price.id)).toEqual(['create']);
    expect((await events(hospital, service.id)).at(-1)).toEqual({
      kind: 'service_price',
      change: 'created',
      priceId: price.id,
    });
  });

  it('goes by the date at the hospital for what today is', async () => {
    const service = await added('Ahead Of The World', { tenant: ahead });
    const theirToday = dateIn(AHEAD_ZONE);
    const body = (effectiveFrom: string) => ({ amountMinor: 100, effectiveFrom });
    expect(
      (await setPrice(service.id, body(dateIn(AHEAD_ZONE, -1)), { tenant: ahead })).statusCode,
    ).toBe(400);
    expect((await setPrice(service.id, body(theirToday), { tenant: ahead })).statusCode).toBe(201);
  });

  it('starts a new price tomorrow or later once one is in force, and ends the old one the day before', async () => {
    const service = await added('Goes Up', {}, { priceMinor: 500 });
    const first = service.currentPrice;
    // What was charged this morning stays what it was.
    expect(errorOf(await setPrice(service.id, { amountMinor: 600, effectiveFrom: day() }))).toEqual(
      [400, 'validation_failed'],
    );
    const next = await setPrice(service.id, { amountMinor: 600, effectiveFrom: day(10) });
    expect(next.statusCode).toBe(201);

    const list = (await prices(service.id)).json<Page<Price>>();
    expect(list.total).toBe(2);
    expect(list.items).toEqual([{ ...next.json<Price>() }, { ...first, effectiveTo: day(9) }]);
    // The one in force today is still the old one.
    expect((await read(service.id)).json<Service>().currentPrice).toMatchObject({
      amountMinor: 500,
      effectiveTo: day(9),
    });
  });

  it('schedules one price at a time', async () => {
    const service = await added('One At A Time', {}, { priceMinor: 500 });
    await setPrice(service.id, { amountMinor: 600, effectiveFrom: day(10) });
    expect(
      errorOf(await setPrice(service.id, { amountMinor: 700, effectiveFrom: day(20) })),
    ).toEqual([409, 'price_date_conflict']);
    expect((await prices(service.id)).json<Page<Price>>().total).toBe(2);
  });

  it('lets one of two prices set at the same moment through', async () => {
    const service = await added('Two At Once', {}, { priceMinor: 500 });
    const results = await Promise.all([
      setPrice(service.id, { amountMinor: 600, effectiveFrom: day(5) }),
      setPrice(service.id, { amountMinor: 700, effectiveFrom: day(6) }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await prices(service.id)).json<Page<Price>>().total).toBe(2);
  });

  it('answers a repeat of the same request with the same price, and sets one', async () => {
    const service = await added('Set Once');
    const key = `prices-${randomUUID()}`;
    const body = { amountMinor: 900, effectiveFrom: day(3) };
    const first = await setPrice(service.id, body, { key });
    const second = await setPrice(service.id, body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect((await prices(service.id)).json<Page<Price>>().total).toBe(1);
  });

  it('withdraws a price that has not started, and the one before carries on', async () => {
    const service = await added('Changed Our Mind', {}, { priceMinor: 500 });
    const scheduled = (
      await setPrice(service.id, { amountMinor: 600, effectiveFrom: day(10) })
    ).json<Price>();

    expect((await withdraw(service.id, scheduled.id)).statusCode).toBe(204);
    const list = (await prices(service.id)).json<Page<Price>>();
    expect(list.items).toEqual([service.currentPrice]);
    expect(list.items[0]?.effectiveTo).toBeUndefined();
    expect(await audited(hospital, 'service_price', scheduled.id)).toEqual(['create', 'delete']);
    // Gone as far as the API is concerned, and another can be scheduled.
    expect(errorOf(await withdraw(service.id, scheduled.id))).toEqual([404, 'price_not_found']);
    expect(
      (await setPrice(service.id, { amountMinor: 650, effectiveFrom: day(10) })).statusCode,
    ).toBe(201);
  });

  it('never withdraws a price that is or was in force', async () => {
    const service = await added('History');
    await pricedSince(service, '2025-04-01', 400);
    const current = (await read(service.id)).json<Service>().currentPrice;
    if (!current) throw new Error('expected a price in force');
    expect(errorOf(await withdraw(service.id, current.id))).toEqual([409, 'price_in_force']);

    const today = (
      await setPrice((await added('Starts Today')).id, { amountMinor: 1, effectiveFrom: day() })
    ).json<Price>();
    expect(errorOf(await withdraw(today.serviceId, today.id))).toEqual([409, 'price_in_force']);
  });

  it('keeps what a service cost on any past date', async () => {
    const service = await added('Three Years');
    const list = await standardList(hospital);
    await pool.query(
      `insert into service_prices
         (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
       values ($1, $2, $3, 300, '2023-04-01', '2024-03-31'),
              ($1, $2, $3, 400, '2024-04-01', null)`,
      [hospital.id, service.id, list],
    );
    await setPrice(service.id, { amountMinor: 500, effectiveFrom: day(30) });

    const all = (await prices(service.id)).json<Page<Price>>().items;
    expect(all.map((price) => [price.amountMinor, price.effectiveFrom, price.effectiveTo])).toEqual(
      [
        [500, day(30), undefined],
        [400, '2024-04-01', day(29)],
        [300, '2023-04-01', '2024-03-31'],
      ],
    );
    const on = async (date: string) => {
      const { rows } = await pool.query<{ amount: string }>(
        `select amount_minor::text as amount from service_prices
         where service_id = $1 and withdrawn_at is null and effective_from <= $2::date
           and (effective_to is null or effective_to >= $2::date)`,
        [service.id, date],
      );
      return rows.map((row) => row.amount);
    };
    expect(await on('2023-12-25')).toEqual(['300']);
    expect(await on('2024-04-01')).toEqual(['400']);
    expect(await on(day())).toEqual(['400']);
    expect(await on(day(30))).toEqual(['500']);
    expect(await on('2022-01-01')).toEqual([]);
  });

  it('lists the prices newest first, a page at a time', async () => {
    const service = await added('Paged Prices');
    const list = await standardList(hospital);
    await pool.query(
      `insert into service_prices
         (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
       values ($1, $2, $3, 1, '2021-01-01', '2021-12-31'), ($1, $2, $3, 2, '2022-01-01', '2022-12-31'),
              ($1, $2, $3, 3, '2023-01-01', null)`,
      [hospital.id, service.id, list],
    );
    const first = (await prices(service.id, '?limit=2')).json<Page<Price>>();
    expect(first.items.map((price) => price.amountMinor)).toEqual([3, 2]);
    expect(first.total).toBe(3);
    const second = (await prices(service.id, `?limit=2&cursor=${first.nextCursor}`)).json<
      Page<Price>
    >();
    expect(second.items.map((price) => price.amountMinor)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    expect(errorOf(await prices(service.id, '?cursor=made-up'))).toEqual([400, 'invalid_cursor']);
  });

  it('gives an archived service no new price', async () => {
    const service = await added('Retired');
    await act(service.id, 'archive');
    expect(errorOf(await setPrice(service.id, { amountMinor: 1, effectiveFrom: day() }))).toEqual([
      409,
      'service_archived',
    ]);
  });

  it('takes a price list of this hospital and no other', async () => {
    const service = await added('Listed');
    const ours = await standardList(hospital);
    const theirs = await standardList(clinic);
    for (const priceListId of [theirs, randomUUID(), 'not-an-id']) {
      expect(
        errorOf(await setPrice(service.id, { amountMinor: 1, effectiveFrom: day(), priceListId })),
        priceListId,
      ).toEqual([404, 'price_list_not_found']);
      expect(errorOf(await prices(service.id, `?priceListId=${priceListId}`))).toEqual([
        404,
        'price_list_not_found',
      ]);
    }
    const response = await setPrice(service.id, {
      amountMinor: 1,
      effectiveFrom: day(),
      priceListId: ours,
    });
    expect(response.statusCode).toBe(201);
    expect((await prices(service.id, `?priceListId=${ours}`)).json<Page<Price>>().total).toBe(1);
  });

  it('needs an amount and a date that is on the calendar', async () => {
    const service = await added('Strict');
    const bad: object[] = [
      { effectiveFrom: day() },
      { amountMinor: 1 },
      { amountMinor: -1, effectiveFrom: day() },
      { amountMinor: 0.5, effectiveFrom: day() },
      { amountMinor: 1, effectiveFrom: 'tomorrow' },
      { amountMinor: 1, effectiveFrom: '2099-02-30' },
      { amountMinor: 1, effectiveFrom: '2099-13-01' },
    ];
    for (const body of bad) {
      expect((await setPrice(service.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await prices(service.id)).json<Page<Price>>().total).toBe(0);
  });

  it('is held to the rules by the database, whatever the SQL', async () => {
    const service = await added('Guarded');
    await pricedSince(service, '2025-04-01', 400);
    const list = await standardList(hospital);
    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));

    // A price is never edited, and never removed.
    await expect(
      sql('update service_prices set amount_minor = 1 where service_id = $1', [service.id]),
    ).rejects.toThrow(/never edited/);
    await expect(
      sql("update service_prices set effective_from = '2020-01-01' where service_id = $1", [
        service.id,
      ]),
    ).rejects.toThrow(/never edited/);
    await expect(sql('delete from service_prices')).rejects.toThrow(/permission denied/);
    // One that is in force is not withdrawn.
    await expect(
      sql('update service_prices set withdrawn_at = now() where service_id = $1', [service.id]),
    ).rejects.toThrow(/not withdrawn/);
    // Two prices of a service never cover the same day.
    await expect(
      sql(
        `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
         values ($1, $2, $3, 999, $4::date)`,
        [hospital.id, service.id, list, day(5)],
      ),
    ).rejects.toThrow(/service_prices_no_overlap/);
    // A price list is the hospital's, made with it: a request adds none.
    await expect(
      sql("insert into price_lists (tenant_id, name) values ($1, 'Second')", [hospital.id]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('access', () => {
  it('lets someone who may only read see services and prices and change nothing', async () => {
    const service = await added('Read Only', {}, { priceMinor: 100 });
    const options = { user: doctor };
    expect((await search({}, options)).statusCode).toBe(200);
    expect((await read(service.id, options)).statusCode).toBe(200);
    expect((await prices(service.id, '', options)).statusCode).toBe(200);
    expect((await app.inject({ url: '/price-lists', headers: headers(options) })).statusCode).toBe(
      200,
    );

    const denied = [403, 'permission_denied'];
    const body = { code: 'NO-1', name: 'No', category: 'lab', taxClass: 'exempt' };
    expect(errorOf(await add(body, options))).toEqual(denied);
    expect(errorOf(await change(service.id, { name: 'No', expectedVersion: 1 }, options))).toEqual(
      denied,
    );
    expect(errorOf(await act(service.id, 'archive', options))).toEqual(denied);
    expect(
      errorOf(await setPrice(service.id, { amountMinor: 1, effectiveFrom: day(1) }, options)),
    ).toEqual(denied);
    expect(errorOf(await withdraw(service.id, randomUUID(), options))).toEqual(denied);
  });

  it('shows nothing to a role without the permission', async () => {
    const options = { user: storeKeeper };
    expect(errorOf(await search({}, options))).toEqual([403, 'permission_denied']);
    expect(errorOf(await app.inject({ url: '/price-lists', headers: headers(options) }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };
    expect(errorOf(await search({}, options))).toEqual([403, 'feature_disabled']);
    expect(
      errorOf(await add({ code: 'X-1', name: 'X', category: 'lab', taxClass: 'exempt' }, options)),
    ).toEqual([403, 'feature_disabled']);
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/services/search', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('keeps each hospital’s services to itself, and lets both use a code', async () => {
    const ours = await added('Shared Code', {}, { code: 'BOTH-1', priceMinor: 100 });
    const theirs = await added('Shared Code', { tenant: clinic }, { code: 'BOTH-1' });
    expect(theirs.tenantId).toBe(clinic.id);

    const seen = (await search({ limit: 100 }, { tenant: clinic })).json<Page<Service>>().items;
    expect(seen.map((item) => item.id)).toEqual([theirs.id]);
    const mine = (await search({ q: 'BOTH-1' })).json<Page<Service>>().items;
    expect(mine.map((item) => item.id)).toEqual([ours.id]);
  });

  it('has one answer for another hospital’s service and one that does not exist', async () => {
    const theirs = await added('Clinic Only', { tenant: clinic }, { priceMinor: 100 });
    const priceId = theirs.currentPrice?.id ?? '';
    const missing = [404, 'service_not_found'];

    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await read(id)), id).toEqual(missing);
      expect(errorOf(await change(id, { name: 'Taken Over', expectedVersion: 1 })), id).toEqual(
        missing,
      );
      expect(errorOf(await act(id, 'archive')), id).toEqual(missing);
      expect(errorOf(await prices(id)), id).toEqual(missing);
      expect(errorOf(await setPrice(id, { amountMinor: 1, effectiveFrom: day(1) })), id).toEqual(
        missing,
      );
      expect(errorOf(await withdraw(id, priceId)), id).toEqual(missing);
    }
    // Nor is their price one of our service's.
    const ours = await added('Ours');
    expect(errorOf(await withdraw(ours.id, priceId))).toEqual([404, 'price_not_found']);

    const { rows } = await pool.query(
      'select name, archived, version from services where id = $1',
      [theirs.id],
    );
    expect(rows[0]).toEqual({ name: 'Clinic Only', archived: false, version: 1 });
  });

  it('is kept apart by the database itself, whatever the SQL', async () => {
    const theirs = await added('Clinic Secret', { tenant: clinic }, { priceMinor: 100 });
    const ours = await added('Hospital Own');
    const theirList = await standardList(clinic);

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      service: (await client.query('select 1 from services where id = $1', [theirs.id])).rowCount,
      price: (await client.query('select 1 from service_prices where service_id = $1', [theirs.id]))
        .rowCount,
      list: (await client.query('select 1 from price_lists where id = $1', [theirList])).rowCount,
      updated: (
        await client.query("update services set name = 'Stolen' where id = $1", [theirs.id])
      ).rowCount,
      tenants: (
        await client.query<{ tenant_id: string }>(
          `select distinct tenant_id from services
           union select distinct tenant_id from service_prices
           union select distinct tenant_id from price_lists`,
        )
      ).rows,
    }));
    expect(seen).toEqual({
      service: 0,
      price: 0,
      list: 0,
      updated: 0,
      tenants: [{ tenant_id: hospital.id }],
    });

    const sql = (text: string, params: unknown[]) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));
    // Nor can a hospital put a service into another, or delete its own.
    await expect(
      sql(
        `insert into services (tenant_id, code, name, category, tax_class)
         values ($1, 'PLANTED', 'Planted', 'lab', 'exempt')`,
        [clinic.id],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(sql('delete from services where id = $1', [ours.id])).rejects.toThrow(
      /permission denied/,
    );
    // Nor price its own service on another hospital's list, or another's service on its own:
    // the references carry the hospital.
    await expect(
      sql(
        `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
         values ($1, $2, $3, 1, current_date)`,
        [hospital.id, ours.id, theirList],
      ),
    ).rejects.toThrow(/service_prices_price_list/);
    await expect(
      sql(
        `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
         values ($1, $2, $3, 1, current_date)`,
        [hospital.id, theirs.id, await standardList(hospital)],
      ),
    ).rejects.toThrow(/service_prices_service/);
  });
});

describe('found in review', () => {
  it('pages a search that has a category and several words, and tells same-named services apart', async () => {
    const twins = [
      await added('Twin Scan Review', {}, { category: 'imaging' }),
      await added('Twin Scan Review', {}, { category: 'imaging' }),
    ];
    await added('Twin Scan Review', {}, { category: 'lab' });
    const body = { q: 'review TWIN', category: 'imaging', limit: 1 };

    const first = (await search(body)).json<Page<Service>>();
    expect(first.total).toBe(2);
    const second = (await search({ ...body, cursor: first.nextCursor })).json<Page<Service>>();
    expect(second.nextCursor).toBeNull();
    expect([first.items[0]?.id, second.items[0]?.id].sort()).toEqual(
      twins.map((twin) => twin.id).sort(),
    );
  });

  it('shows in a search the price in force today: not a scheduled, ended or withdrawn one', async () => {
    const list = await standardList(hospital);
    const unpriced = await added('Review Price None');
    const scheduledOnly = await added('Review Price Later');
    await setPrice(scheduledOnly.id, { amountMinor: 900, effectiveFrom: day(5) });
    const moved = await added('Review Price Moved');
    await pool.query(
      `insert into service_prices
         (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
       values ($1, $2, $3, 100, '2024-01-01', '2024-12-31'), ($1, $2, $3, 200, '2025-01-01', null)`,
      [hospital.id, moved.id, list],
    );
    const next = (
      await setPrice(moved.id, { amountMinor: 300, effectiveFrom: day(7) })
    ).json<Price>();
    await withdraw(moved.id, next.id);

    const found = (await search({ q: 'Review Price', limit: 100 })).json<Page<Service>>().items;
    const priceOf = (id: string) => found.find((item) => item.id === id)?.currentPrice?.amountMinor;
    expect(found).toHaveLength(3);
    expect(priceOf(unpriced.id)).toBeUndefined();
    expect(priceOf(scheduledOnly.id)).toBeUndefined();
    expect(priceOf(moved.id)).toBe(200);
  });

  it('lets a client work out what a service cost on a past date from its list of prices', async () => {
    const service = await added('Review Past Dates');
    await pool.query(
      `insert into service_prices
         (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
       values ($1, $2, $3, 300, '2023-04-01', '2024-03-31'), ($1, $2, $3, 400, '2024-04-01', null)`,
      [hospital.id, service.id, await standardList(hospital)],
    );
    const items = (await prices(service.id)).json<Page<Price>>().items;
    const on = (date: string) =>
      items
        .filter(
          (price) =>
            price.effectiveFrom <= date &&
            (price.effectiveTo === undefined || price.effectiveTo >= date),
        )
        .map((price) => price.amountMinor);
    expect(on('2023-12-25')).toEqual([300]);
    expect(on('2024-03-31')).toEqual([300]);
    expect(on('2024-04-01')).toEqual([400]);
    expect(on(day())).toEqual([400]);
    expect(on('2023-03-31')).toEqual([]);
  });

  it('records a price that comes with a new service as a price of its own', async () => {
    const service = await added('Review First Price', {}, { priceMinor: 700 });
    const priceId = service.currentPrice?.id ?? '';
    expect(await audited(hospital, 'service_price', priceId)).toEqual(['create']);
    expect(await events(hospital, service.id)).toEqual(
      expect.arrayContaining([
        { kind: 'service_price', change: 'created', priceId },
        { kind: 'service', change: 'created' },
      ]),
    );
  });

  it('withdraws a first price that had not started, leaving the service with none', async () => {
    const service = await added('Review Sole Price');
    const price = (
      await setPrice(service.id, { amountMinor: 100, effectiveFrom: day(3) })
    ).json<Price>();
    expect((await withdraw(service.id, price.id)).statusCode).toBe(204);
    expect((await prices(service.id)).json<Page<Price>>()).toMatchObject({ items: [], total: 0 });
    expect((await events(hospital, service.id)).at(-1)).toEqual({
      kind: 'service_price',
      change: 'withdrawn',
      priceId: price.id,
    });
  });

  it('goes by the date at the hospital for every rule about today', async () => {
    const options = { tenant: ahead };
    const service = await added('Review Ahead', options, { priceMinor: 100 });
    const theirs = (days: number) => dateIn(AHEAD_ZONE, days);
    // Their today already has a price in force, so the next one starts on their tomorrow.
    expect(
      errorOf(await setPrice(service.id, { amountMinor: 200, effectiveFrom: theirs(0) }, options)),
    ).toEqual([400, 'validation_failed']);
    const next = await setPrice(
      service.id,
      { amountMinor: 200, effectiveFrom: theirs(1) },
      options,
    );
    expect(next.statusCode).toBe(201);
    // The one that started on their today is in force, whatever the date is elsewhere.
    expect(errorOf(await withdraw(service.id, service.currentPrice?.id ?? '', options))).toEqual([
      409,
      'price_in_force',
    ]);
    expect((await withdraw(service.id, next.json<Price>().id, options)).statusCode).toBe(204);
  });

  it('refuses a cursor with a date the database does not have', async () => {
    const service = await added('Review Cursor');
    const cursor = Buffer.from(JSON.stringify({ f: '0000-01-01', i: randomUUID() })).toString(
      'base64url',
    );
    expect(errorOf(await prices(service.id, `?cursor=${cursor}`))).toEqual([400, 'invalid_cursor']);
  });

  it('keeps the past of a price as it was, whatever the SQL', async () => {
    const service = await added('Review Guarded Past');
    const list = await standardList(hospital);
    await pool.query(
      `insert into service_prices
         (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
       values ($1, $2, $3, 300, '2023-04-01', '2024-03-31'), ($1, $2, $3, 400, '2024-04-01', null)`,
      [hospital.id, service.id, list],
    );
    const scheduled = (
      await setPrice(service.id, { amountMinor: 500, effectiveFrom: day(10) })
    ).json<Price>();
    await withdraw(service.id, scheduled.id);
    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));

    // A period that has ended is not cut short or reopened.
    for (const lastDay of ["'2023-06-30'", 'null']) {
      await expect(
        sql(
          `update service_prices set effective_to = ${lastDay}
           where service_id = $1 and effective_from = '2023-04-01'`,
          [service.id],
        ),
      ).rejects.toThrow(/not rewritten/);
    }
    // The price in force is not made to have ended in the past.
    await expect(
      sql(
        `update service_prices set effective_to = '2025-01-01'
         where service_id = $1 and effective_from = '2024-04-01'`,
        [service.id],
      ),
    ).rejects.toThrow(/not rewritten/);
    // A withdrawn price is not brought back or changed.
    await expect(
      sql('update service_prices set withdrawn_at = null where id = $1', [scheduled.id]),
    ).rejects.toThrow(/withdrawn price is not changed/);
    // A period does not end before it starts, and a hospital has one standard list.
    await expect(
      pool.query(
        `insert into service_prices
           (tenant_id, service_id, price_list_id, amount_minor, effective_from, effective_to)
         values ($1, $2, $3, 1, '2030-02-01', '2030-01-01')`,
        [hospital.id, service.id, list],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.query("insert into price_lists (tenant_id, name, standard) values ($1, 'Other', true)", [
        hospital.id,
      ]),
    ).rejects.toThrow(/price_lists_one_standard/);
    // And a list that has prices is not removed.
    await expect(pool.query('delete from price_lists where id = $1', [list])).rejects.toThrow(
      /service_prices_price_list/,
    );
  });
});

describe('a price that was not sent as a number', () => {
  it('is refused, and never read as a price of 0', async () => {
    const good = { code: code(), name: 'Null Price', category: 'lab', taxClass: 'exempt' };
    for (const priceMinor of [null, true, '500']) {
      expect((await add({ ...good, priceMinor })).statusCode, String(priceMinor)).toBe(400);
    }
    expect(names(await search({ q: 'Null Price' }))).toEqual([]);

    const service = await added('Null Amount');
    for (const amountMinor of [null, false, '500']) {
      const response = await setPrice(service.id, { amountMinor, effectiveFrom: day() });
      expect(response.statusCode, String(amountMinor)).toBe(400);
    }
    expect((await prices(service.id)).json<Page<Price>>().total).toBe(0);
  });
});

describe('the text of a name and a description', () => {
  // Written by code point, so that this file holds no character that cannot be seen.
  const zeroWidth = String.fromCodePoint(0x200b);
  const override = String.fromCodePoint(0x202e);
  const composed = `Caf${String.fromCodePoint(0xe9)}`;
  const decomposed = `Cafe${String.fromCodePoint(0x301)}`;
  const body = () => ({ code: code('TX'), name: 'Fine', category: 'lab', taxClass: 'exempt' });

  it('stores a name with single spaces and in one normal form', async () => {
    const response = await add({ ...body(), name: `  ${decomposed}   screening  ` });
    expect(response.statusCode).toBe(201);
    const service = response.json<Service>();
    expect(service.name).toBe(`${composed} screening`);
    // Sent again with other spacing, it is the name the service already has.
    const same = await change(service.id, {
      name: `${composed}    screening`,
      expectedVersion: 1,
    });
    expect(same.json()).toMatchObject({ version: 1 });
  });

  it('refuses text that would not read as it was typed', async () => {
    const bad: object[] = [
      { ...body(), name: zeroWidth },
      { ...body(), name: `Scan${override}A` },
      { ...body(), name: 'Two\nlines' },
      { ...body(), description: `Hidden${override}` },
      { ...body(), description: 'A\ttab' },
    ];
    for (const sent of bad) {
      expect((await add(sent)).statusCode, JSON.stringify(sent)).toBe(400);
    }
    // A search term is tidied, never refused (#322).
    expect((await search({ q: `x${override}` })).statusCode).toBe(200);
  });

  it('keeps the lines of a description, each one tidied', async () => {
    const response = await add({
      ...body(),
      description: '  First   line \r\n\r\n\r\n second line  ',
    });
    expect(response.json()).toMatchObject({ description: 'First line\n\nsecond line' });
  });
});
