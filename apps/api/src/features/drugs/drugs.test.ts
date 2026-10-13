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
 * The drugs and consumables API through the real app and database: the search and its paging,
 * the duplicate check, adding, changing with a version, archiving, the hospital boundary,
 * permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the drugs module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Sees items, cannot change them. */
let pharmacist: TestUser;
/** No drug permissions at all. */
let receptionist: TestUser;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Drug {
  id: string;
  tenantId: string;
  type: string;
  genericName: string;
  brandName?: string;
  form: string;
  strength?: string;
  unit?: string;
  schedule: string;
  controlled: boolean;
  taxClass: string;
  reorderLevel?: number;
  archived: boolean;
  version: number;
}
interface Page {
  items: Drug[];
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
const search = (body: object = {}, options: Options = {}) => post('/drugs/search', body, options);
const add = (body: object, options: Options = {}) => post('/drugs', body, options);
const similar = (body: object, options: Options = {}) =>
  post('/drugs/duplicate-check', body, options);
const read = (id: string, options: Options = {}) =>
  app.inject({ url: `/drugs/${id}`, headers: headers(options) });
const change = (id: string, body: object, options: Options = {}) =>
  app.inject({ method: 'PATCH', url: `/drugs/${id}`, headers: headers(options), payload: body });
const act = (id: string, action: 'archive' | 'restore', options: Options = {}) =>
  post(`/drugs/${id}/${action}`, undefined, options);

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
/** "Generic Brand" of every item of a page, as a search shows them. */
const labels = (response: Response) =>
  response.json<Page>().items.map((item) => [item.genericName, item.brandName].join(' ').trim());

const TABLET = { type: 'medicine', form: 'tablet', schedule: 'none', taxClass: 'reduced' };

/** Adds an item and returns it. */
async function added(genericName: string, more: object = {}, options: Options = {}) {
  const response = await add({ ...TABLET, genericName, ...more }, options);
  if (response.statusCode !== 201) throw new Error(`could not add ${genericName} in test setup`);
  return response.json<Drug>();
}

const audited = async (tenant: TestTenant, entityId: string) => {
  const { rows } = await pool.query<{ action: string }>(
    `select action from audit_log
     where tenant_id = $1 and entity = 'drug' and entity_id = $2 order by at`,
    [tenant.id, entityId],
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
  hospital = await createTenant(pool, 'Drugs Hospital', { features: { drugs: true } });
  clinic = await createTenant(pool, 'Drugs Clinic', { features: { drugs: true } });
  closed = await createTenant(pool, 'Drugs Closed', { features: { drugs: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Drugs Admin', { withPassword: false });
  pharmacist = await createUser(pool, 'Drugs Pharmacist', { withPassword: false });
  receptionist = await createUser(pool, 'Drugs Receptionist', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, receptionist, hospital, 'receptionist');
});

afterAll(async () => {
  const tenants = [hospital, clinic, closed].filter(Boolean);
  try {
    // Items have no ON DELETE CASCADE from tenants, so the test rows go first.
    await pool.query('delete from drugs where tenant_id = any($1::uuid[])', [
      tenants.map((tenant) => tenant.id),
    ]);
    await deleteUsers(pool, [admin, pharmacist, receptionist].filter(Boolean));
    await deleteTenants(pool, tenants);
  } finally {
    await app.close();
  }
});

describe('adding an item', () => {
  it('adds it to the session’s hospital, trimmed, and records who did', async () => {
    const response = await add({
      type: 'medicine',
      genericName: '  Paracetamol  ',
      brandName: ' Calpol ',
      form: 'tablet',
      strength: ' 500 mg ',
      unit: ' strip of 10 ',
      schedule: 'none',
      taxClass: 'reduced',
      reorderLevel: 50,
    });
    expect(response.statusCode).toBe(201);
    const drug = response.json<Drug>();
    expect(drug).toEqual({
      id: drug.id,
      tenantId: hospital.id,
      type: 'medicine',
      genericName: 'Paracetamol',
      brandName: 'Calpol',
      form: 'tablet',
      strength: '500 mg',
      unit: 'strip of 10',
      schedule: 'none',
      controlled: false,
      taxClass: 'reduced',
      reorderLevel: 50,
      archived: false,
      version: 1,
    });
    expect(await audited(hospital, drug.id)).toEqual(['create']);
    expect(await events(hospital, drug.id)).toEqual([{ kind: 'drug', change: 'created' }]);
  });

  it('leaves out a brand, a strength, a unit and a level that were not given or were empty', async () => {
    const drug = await added('Surgical gloves', {
      type: 'consumable',
      form: 'device',
      brandName: '  ',
      strength: '',
    });
    expect(drug).not.toHaveProperty('brandName');
    expect(drug).not.toHaveProperty('strength');
    expect(drug).not.toHaveProperty('unit');
    expect(drug).not.toHaveProperty('reorderLevel');
  });

  it('makes a Schedule X or narcotic item controlled whatever is sent, and no other', async () => {
    const x = await added('Alprazolam', { schedule: 'x', controlled: false });
    const narcotic = await added('Morphine', { schedule: 'narcotic', form: 'injection' });
    const h = await added('Amoxicillin', { schedule: 'h' });
    const chosen = await added('Tramadol', { schedule: 'h1', controlled: true });
    expect([x, narcotic, h, chosen].map((drug) => drug.controlled)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it('refuses exactly the same item, whatever its capitals, archived or not', async () => {
    const item = { brandName: 'Zithro', strength: '250 mg' };
    const first = await added('Azithromycin', item);
    const again = {
      ...TABLET,
      genericName: 'AZITHROMYCIN',
      brandName: 'zithro',
      strength: '250 MG',
    };
    expect(errorOf(await add(again))).toEqual([409, 'drug_exists']);
    await act(first.id, 'archive');
    expect(errorOf(await add(again))).toEqual([409, 'drug_exists']);
    // Another strength, form or brand, or none, is another item.
    expect((await add({ ...again, strength: '500 mg' })).statusCode).toBe(201);
    expect((await add({ ...again, form: 'capsule' })).statusCode).toBe(201);
    expect((await add({ ...again, brandName: 'Azee' })).statusCode).toBe(201);
    const { brandName: _brand, ...unbranded } = again;
    expect((await add(unbranded)).statusCode).toBe(201);
    expect(errorOf(await add({ ...unbranded, brandName: ' ' }))).toEqual([409, 'drug_exists']);
  });

  it('lets one of two simultaneous requests for a new item through', async () => {
    const body = { ...TABLET, genericName: 'Racemol' };
    const results = await Promise.all([add(body), add(body)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('answers a repeat of the same request with the same item, and adds one', async () => {
    const body = { ...TABLET, genericName: 'Idempotol' };
    const key = `drugs-${randomUUID()}`;
    const first = await add(body, { key });
    const second = await add(body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(labels(await search({ q: 'Idempotol' }))).toEqual(['Idempotol']);
    expect(errorOf(await add({ ...body, genericName: 'Otherol' }, { key }))).toEqual([
      422,
      'idempotency_key_reuse',
    ]);
  });

  it('needs a type, a name, a form, a schedule and a tax class it knows', async () => {
    const good = { ...TABLET, genericName: 'Fine' };
    const bad: object[] = [
      { ...good, genericName: '   ' },
      { ...good, genericName: 'x'.repeat(151) },
      { ...good, genericName: 'nul\u0000' },
      { ...good, type: 'vaccine' },
      { ...good, form: 'pill' },
      { ...good, schedule: 'z' },
      { ...good, taxClass: 'zero' },
      { ...good, brandName: 'x'.repeat(151) },
      { ...good, strength: 'x'.repeat(31) },
      { ...good, unit: 'x'.repeat(31) },
      { ...good, reorderLevel: -1 },
      { ...good, reorderLevel: 1.5 },
      { ...good, reorderLevel: 1_000_001 },
      { ...good, controlled: 'yes' },
      { genericName: 'Fine' },
    ];
    for (const body of bad) {
      expect((await add(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(labels(await search({ q: 'Fine' }))).toEqual([]);
  });
});

describe('the duplicate check', () => {
  it('finds the same generic name in the same form, whatever the brand, strength or capitals', async () => {
    await added('Checkol', { brandName: 'Beta', strength: '10 mg' });
    await added('Checkol', { brandName: 'Alpha', strength: '20 mg' });
    const archived = await added('Checkol', { brandName: 'Gamma' });
    await act(archived.id, 'archive');
    await added('Checkol', { form: 'syrup' });
    await added('Checkolate');

    const response = await similar({ genericName: ' checkOL ', form: 'tablet' });
    expect(response.statusCode).toBe(200);
    expect(response.json<Page>().items.map((item) => item.brandName)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect((await similar({ genericName: 'Nothing', form: 'tablet' })).json()).toEqual({
      items: [],
    });
  });

  it('gives at most ten, and needs a name and a form', async () => {
    for (let n = 0; n < 12; n++) await added('Manyol', { brandName: `Brand ${n}` });
    const many = await similar({ genericName: 'Manyol', form: 'tablet' });
    expect(many.json<Page>().items).toHaveLength(10);
    expect((await similar({ genericName: 'Manyol' })).statusCode).toBe(400);
    expect((await similar({ genericName: '  ', form: 'tablet' })).statusCode).toBe(400);
  });
});

describe('the search', () => {
  let fresh: TestTenant;

  beforeAll(async () => {
    // Its own hospital, so the other tests' items are not in the way.
    fresh = await createTenant(pool, 'Drugs Search', { features: { drugs: true } });
    await grantRoleDefaults(app, fresh);
    await addMembership(pool, admin, fresh, 'admin');
    const rows: [string, object][] = [
      ['amoxicillin', { brandName: 'Mox', schedule: 'h' }],
      ['Amoxicillin', { brandName: 'amoxil', schedule: 'h', form: 'capsule' }],
      ['Amoxicillin', { schedule: 'h', form: 'syrup' }],
      ['Alprazolam', { brandName: 'Alprax', schedule: 'x' }],
      ['Cetirizine', { brandName: 'Cetzine 100%' }],
      ['Syringe 5 ml', { type: 'consumable', form: 'device', taxClass: 'standard' }],
    ];
    for (const [genericName, more] of rows) await added(genericName, more, { tenant: fresh });
    const old = await added('Withdrawn syrup', { form: 'syrup' }, { tenant: fresh });
    await act(old.id, 'archive', { tenant: fresh });
  });

  afterAll(async () => {
    await pool.query('delete from drugs where tenant_id = $1', [fresh.id]);
    await deleteTenants(pool, [fresh]);
  });

  const find = (body: object = {}) => search(body, { tenant: fresh });

  it('is by generic name then brand whatever the capitals, a page at a time, with the total once', async () => {
    const first = await find({ limit: 4 });
    expect(first.statusCode).toBe(200);
    expect(labels(first)).toEqual([
      'Alprazolam Alprax',
      'Amoxicillin',
      'Amoxicillin amoxil',
      'amoxicillin Mox',
    ]);
    const page = first.json<Page>();
    expect(page.total).toBe(6);

    const second = await find({ limit: 4, cursor: page.nextCursor });
    expect(labels(second)).toEqual(['Cetirizine Cetzine 100%', 'Syringe 5 ml']);
    expect(second.json<Page>().nextCursor).toBeNull();
    expect(second.json<Page>().total).toBeUndefined();
  });

  it('finds every word of what was typed in the generic name or the brand, in any order', async () => {
    expect(labels(await find({ q: 'amox' }))).toHaveLength(3);
    expect(labels(await find({ q: 'AMOXIL amoxicillin' }))).toEqual(['Amoxicillin amoxil']);
    expect(labels(await find({ q: 'alprax' }))).toEqual(['Alprazolam Alprax']);
    expect(labels(await find({ q: 'nothing like it' }))).toEqual([]);
    // What was typed is text, not a pattern.
    expect(labels(await find({ q: '100%' }))).toEqual(['Cetirizine Cetzine 100%']);
    expect(labels(await find({ q: '_' }))).toEqual([]);
  });

  it('filters by type, form, schedule and controlled, together and with a cursor', async () => {
    expect(labels(await find({ type: 'consumable' }))).toEqual(['Syringe 5 ml']);
    expect(labels(await find({ form: 'capsule' }))).toEqual(['Amoxicillin amoxil']);
    expect(labels(await find({ schedule: 'x' }))).toEqual(['Alprazolam Alprax']);
    expect(labels(await find({ controlled: true }))).toEqual(['Alprazolam Alprax']);
    expect(labels(await find({ controlled: false }))).toHaveLength(6);

    const body = { q: 'amox', type: 'medicine', schedule: 'h', limit: 2 };
    const first = (await find(body)).json<Page>();
    expect(first.total).toBe(3);
    const second = await find({ ...body, cursor: first.nextCursor });
    expect(labels(second)).toEqual(['amoxicillin Mox']);
  });

  it('shows the archived items only when asked', async () => {
    expect(labels(await find({ archived: true }))).toEqual(['Withdrawn syrup']);
    expect(labels(await find())).not.toContain('Withdrawn syrup');
  });

  it('refuses a cursor it did not make, and a search it does not understand', async () => {
    expect(errorOf(await find({ cursor: 'made-up' }))).toEqual([400, 'invalid_cursor']);
    expect((await find({ limit: 101 })).statusCode).toBe(400);
    expect((await find({ form: 'pill' })).statusCode).toBe(400);
    expect((await find({ q: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});

describe('changing an item', () => {
  it('saves new details from the version that was read, and says which changed', async () => {
    const drug = await added('Beforol', { brandName: 'Old', strength: '5 mg' });
    const response = await change(drug.id, {
      genericName: ' Afterol ',
      brandName: 'New',
      unit: 'strip of 10',
      taxClass: 'standard',
      reorderLevel: 20,
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: drug.id,
      genericName: 'Afterol',
      brandName: 'New',
      strength: '5 mg',
      unit: 'strip of 10',
      taxClass: 'standard',
      reorderLevel: 20,
      version: 2,
    });
    expect(await audited(hospital, drug.id)).toEqual(['create', 'update']);
    expect((await events(hospital, drug.id)).at(-1)).toEqual({
      kind: 'drug',
      change: 'updated',
      fields: ['genericName', 'brandName', 'unit', 'taxClass', 'reorderLevel'],
    });
  });

  it('leaves its own trace when the schedule or the controlled flag changes', async () => {
    const drug = await added('Classol', { schedule: 'x' });
    const down = await change(drug.id, { schedule: 'h', controlled: false, expectedVersion: 1 });
    expect(down.json()).toMatchObject({ schedule: 'h', controlled: false, version: 2 });
    // Back into a controlled schedule: controlled again, whatever is sent.
    const up = await change(drug.id, {
      schedule: 'narcotic',
      controlled: false,
      expectedVersion: 2,
    });
    expect(up.json()).toMatchObject({ schedule: 'narcotic', controlled: true, version: 3 });
    expect(await audited(hospital, drug.id)).toEqual(['create', 'reclassify', 'reclassify']);
    expect((await events(hospital, drug.id)).at(-1)).toMatchObject({
      fields: ['schedule', 'controlled'],
    });
    // A controlled schedule cannot be left uncontrolled by sending the flag alone.
    const stay = await change(drug.id, { controlled: false, expectedVersion: 3 });
    expect(stay.json()).toMatchObject({ controlled: true, version: 3 });
  });

  it('removes a brand, a strength or a unit sent empty, and a level sent as null', async () => {
    const drug = await added('Removol', {
      brandName: 'Brand',
      strength: '1 g',
      unit: 'vial',
      reorderLevel: 5,
    });
    const response = await change(drug.id, {
      brandName: '',
      strength: '  ',
      unit: '',
      reorderLevel: null,
      expectedVersion: 1,
    });
    const saved = response.json<Drug>();
    for (const field of ['brandName', 'strength', 'unit', 'reorderLevel']) {
      expect(saved, field).not.toHaveProperty(field);
    }
    expect(saved.version).toBe(2);
  });

  it('refuses a change made from an older version, and changes nothing', async () => {
    const drug = await added('Movol');
    await change(drug.id, { genericName: 'Movol Once', expectedVersion: 1 });
    expect(errorOf(await change(drug.id, { genericName: 'Too Late', expectedVersion: 1 }))).toEqual(
      [409, 'conflict'],
    );
    expect((await read(drug.id)).json()).toMatchObject({ genericName: 'Movol Once', version: 2 });
  });

  it('writes nothing when what is sent is what it already has', async () => {
    const drug = await added('Samol', { brandName: 'Same', reorderLevel: 3 });
    const response = await change(drug.id, {
      genericName: ' Samol ',
      brandName: 'Same',
      reorderLevel: 3,
      form: 'tablet',
      expectedVersion: 1,
    });
    expect(response.json()).toMatchObject({ version: 1 });
    expect(await audited(hospital, drug.id)).toEqual(['create']);
    expect(await events(hospital, drug.id)).toHaveLength(1);
  });

  it('refuses a change that would make it the same as another, and lets it keep its own name', async () => {
    await added('Takenol', { brandName: 'One' });
    const other = await added('Takenol', { brandName: 'Two' });
    expect(errorOf(await change(other.id, { brandName: 'ONE', expectedVersion: 1 }))).toEqual([
      409,
      'drug_exists',
    ]);
    const recased = await change(other.id, { genericName: 'TAKENOL', expectedVersion: 1 });
    expect(recased.json()).toMatchObject({ genericName: 'TAKENOL', version: 2 });
  });

  it('lets one of two changes made from the same version through', async () => {
    const drug = await added('Contestol');
    const results = await Promise.all([
      change(drug.id, { unit: 'A', expectedVersion: 1 }),
      change(drug.id, { unit: 'B', expectedVersion: 1 }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('refuses what it cannot store', async () => {
    const drug = await added('Strictol');
    for (const body of [
      { genericName: '  ', expectedVersion: 1 },
      { genericName: 'No version' },
      { form: 'pill', expectedVersion: 1 },
      { reorderLevel: -1, expectedVersion: 1 },
    ]) {
      expect((await change(drug.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('archives and restores, and doing either twice changes nothing', async () => {
    const drug = await added('Comesol');
    expect((await act(drug.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(drug.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(drug.id, 'restore')).json()).toMatchObject({ archived: false, version: 3 });
    expect((await act(drug.id, 'restore')).json()).toMatchObject({ version: 3 });
    expect(await audited(hospital, drug.id)).toEqual(['create', 'archive', 'restore']);
    expect((await events(hospital, drug.id)).map((payload) => payload.change)).toEqual([
      'created',
      'archived',
      'restored',
    ]);
  });
});

describe('access', () => {
  it('lets someone who may only read see items and change nothing', async () => {
    const drug = await added('Readol');
    const options = { user: pharmacist };
    expect((await search({}, options)).statusCode).toBe(200);
    expect((await read(drug.id, options)).statusCode).toBe(200);

    const denied = [403, 'permission_denied'];
    expect(errorOf(await add({ ...TABLET, genericName: 'No' }, options))).toEqual(denied);
    expect(errorOf(await similar({ genericName: 'No', form: 'tablet' }, options))).toEqual(denied);
    expect(errorOf(await change(drug.id, { unit: 'No', expectedVersion: 1 }, options))).toEqual(
      denied,
    );
    expect(errorOf(await act(drug.id, 'archive', options))).toEqual(denied);
  });

  it('shows nothing to a role without the permission', async () => {
    expect(errorOf(await search({}, { user: receptionist }))).toEqual([403, 'permission_denied']);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };
    expect(errorOf(await search({}, options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await add({ ...TABLET, genericName: 'X' }, options))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/drugs/search', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('keeps each hospital’s items to itself, and lets both have the same item', async () => {
    const ours = await added('Sharedol', { brandName: 'Both' });
    const theirs = await added('Sharedol', { brandName: 'Both' }, { tenant: clinic });
    expect(theirs.tenantId).toBe(clinic.id);

    const seen = (await search({ limit: 100 }, { tenant: clinic })).json<Page>().items;
    expect(seen.map((item) => item.id)).toEqual([theirs.id]);
    expect((await search({ q: 'Sharedol' })).json<Page>().items.map((item) => item.id)).toEqual([
      ours.id,
    ]);
    // The duplicate check does not see across either.
    const matches = await similar({ genericName: 'Sharedol', form: 'tablet' }, { tenant: clinic });
    expect(matches.json<Page>().items.map((item) => item.id)).toEqual([theirs.id]);
  });

  it('has one answer for another hospital’s item and one that does not exist', async () => {
    const theirs = await added('Clinicol', {}, { tenant: clinic });
    const missing = [404, 'drug_not_found'];
    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await read(id)), id).toEqual(missing);
      expect(errorOf(await change(id, { unit: 'Taken', expectedVersion: 1 })), id).toEqual(missing);
      expect(errorOf(await act(id, 'archive')), id).toEqual(missing);
    }
    const { rows } = await pool.query('select unit, archived, version from drugs where id = $1', [
      theirs.id,
    ]);
    expect(rows[0]).toEqual({ unit: null, archived: false, version: 1 });
  });

  it('is kept apart, and held to its rules, by the database itself', async () => {
    const theirs = await added('Secretol', {}, { tenant: clinic });
    const ours = await added('Ownol');

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      read: (await client.query('select 1 from drugs where id = $1', [theirs.id])).rowCount,
      updated: (await client.query("update drugs set unit = 'Stolen' where id = $1", [theirs.id]))
        .rowCount,
      tenants: (await client.query<{ tenant_id: string }>('select distinct tenant_id from drugs'))
        .rows,
    }));
    expect(seen).toEqual({ read: 0, updated: 0, tenants: [{ tenant_id: hospital.id }] });

    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));
    const insert = `insert into drugs (tenant_id, type, generic_name, form, schedule, controlled, tax_class)
      values ($1, 'medicine', $2, 'tablet', $3, $4, 'reduced')`;
    // Nor can a hospital put an item into another, or delete its own.
    await expect(sql(insert, [clinic.id, 'Planted', 'none', false])).rejects.toThrow(
      /row-level security/,
    );
    await expect(sql('delete from drugs where id = $1', [ours.id])).rejects.toThrow(
      /permission denied/,
    );
    // A Schedule X or narcotic item is controlled, and the same item is not added twice.
    await expect(sql(insert, [hospital.id, 'Loose', 'x', false])).rejects.toThrow(
      /drugs_controlled_schedules/,
    );
    await expect(
      sql("update drugs set schedule = 'narcotic', controlled = false where id = $1", [ours.id]),
    ).rejects.toThrow(/drugs_controlled_schedules/);
    await expect(sql(insert, [hospital.id, 'OWNOL', 'none', false])).rejects.toThrow(
      /drugs_exists/,
    );
  });
});

describe('found in review', () => {
  it('keeps a reorder level of 0 as 0, and takes null as no level', async () => {
    const zero = await added('Review Zero', { reorderLevel: 0 });
    expect(zero.reorderLevel).toBe(0);
    const none = await added('Review Null', { reorderLevel: null });
    expect(none).not.toHaveProperty('reorderLevel');

    const five = await added('Review Five', { reorderLevel: 5 });
    const toZero = await change(five.id, { reorderLevel: 0, expectedVersion: 1 });
    expect(toZero.json()).toMatchObject({ reorderLevel: 0, version: 2 });
    const toNone = await change(five.id, { reorderLevel: null, expectedVersion: 2 });
    expect(toNone.json<Drug>()).not.toHaveProperty('reorderLevel');
    expect(toNone.json<Drug>().version).toBe(3);
    const back = await change(five.id, { reorderLevel: 0, expectedVersion: 3 });
    expect(back.json()).toMatchObject({ reorderLevel: 0, version: 4 });
  });

  it('pages through the same generic name and brand in several strengths, each row once', async () => {
    const ids: string[] = [];
    for (const strength of ['125 mg', '250 mg', '500 mg']) {
      ids.push((await added('Review Strengths', { brandName: 'Same', strength })).id);
    }
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = (
        await search({ q: 'Review Strengths', limit: 1, ...(cursor ? { cursor } : {}) })
      ).json<Page>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(ids.sort());
  });

  it('refuses a cursor that is not one of its own, whatever its shape', async () => {
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const forged of [
      cursor({ g: 'a', b: 'b', i: 'not-a-uuid' }),
      cursor({ g: 1, b: 'b', i: randomUUID() }),
      cursor({ g: 'a', i: randomUUID() }),
      cursor(['a', 'b', randomUUID()]),
      cursor({ g: 'x'.repeat(151), b: '', i: randomUUID() }),
    ]) {
      expect(errorOf(await search({ cursor: forged })), forged).toEqual([400, 'invalid_cursor']);
    }
    expect((await search({ cursor: 'x'.repeat(1025) })).statusCode).toBe(400);
  });

  it('stores a name in one form, with single spaces, so look-alikes are the same item', async () => {
    // "é" typed as one character and as e + a combining accent.
    const first = await added('Review Café  Forte ');
    expect(first.genericName).toBe('Review Café Forte');
    expect(errorOf(await add({ ...TABLET, genericName: 'Review Café Forte' }))).toEqual([
      409,
      'drug_exists',
    ]);
  });

  it('refuses text that would not read as it was typed', async () => {
    const bad = [
      'Review\nNewline',
      'Review‮Override',
      'Review⁦Isolate',
      'Review​ZeroWidth',
      '​',
      'Review\tTab',
    ];
    for (const genericName of bad) {
      expect((await add({ ...TABLET, genericName })).statusCode, JSON.stringify(genericName)).toBe(
        400,
      );
      expect(
        (await add({ ...TABLET, genericName: 'Review Fine', brandName: genericName })).statusCode,
      ).toBe(400);
    }
    // The joiners Indic scripts need are text like any other.
    const hindi = await added('क्‍ष Review');
    expect(hindi.genericName).toBe('क्‍ष Review');
  });

  it('lets an archived item be changed, as the catalog screen does', async () => {
    const drug = await added('Review Archived');
    await act(drug.id, 'archive');
    const response = await change(drug.id, { unit: 'box', expectedVersion: 2 });
    expect(response.json()).toMatchObject({ unit: 'box', archived: true, version: 3 });
  });

  it('counts the version in the database, and never moves an item to another hospital', async () => {
    const drug = await added('Review Trigger');
    const { rows } = await pool.query<{ version: number }>(
      "update drugs set unit = 'box', version = 99 where id = $1 returning version",
      [drug.id],
    );
    expect(rows[0]?.version).toBe(2);
    await expect(
      pool.query('update drugs set tenant_id = $2 where id = $1', [drug.id, clinic.id]),
    ).rejects.toThrow(/cannot be changed/);
  });
});
