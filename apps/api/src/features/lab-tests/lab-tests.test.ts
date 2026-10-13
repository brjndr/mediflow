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
 * The lab tests API through the real app and database: the search, tests and panels, the link
 * to a service, reference ranges by sex and age, which range applies to a patient, the hospital
 * boundary, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the lab tests module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Sees tests, cannot change them. */
let technician: TestUser;
/** No lab test permissions at all. */
let pharmacist: TestUser;
/** A laboratory service and a consultation of the hospital, and a laboratory service of the clinic. */
let labService: string;
let otherService: string;
let clinicService: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Age {
  value: number;
  unit: 'days' | 'weeks' | 'months' | 'years';
}
interface Range {
  sex: 'any' | 'male' | 'female';
  ageFrom: Age;
  ageUntil?: Age;
  low?: number;
  high?: number;
  criticalLow?: number;
  criticalHigh?: number;
  note?: string;
}
interface Ranges {
  labTestId: string;
  ranges: Range[];
  version: number;
}
interface LabTest {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  department: string;
  kind: 'test' | 'panel';
  resultType: 'numeric' | 'text';
  unit?: string;
  sampleType: string;
  container?: string;
  turnaroundHours: number;
  serviceId?: string;
  serviceName?: string;
  components: { id: string; code: string; name: string }[];
  archived: boolean;
  version: number;
}
interface Page {
  items: LabTest[];
  nextCursor: string | null;
  total?: number;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
const send = (
  method: 'POST' | 'PATCH' | 'PUT',
  url: string,
  body?: object,
  options: Options = {},
) => app.inject({ method, url, headers: headers(options), ...(body ? { payload: body } : {}) });
const search = (body: object = {}, options: Options = {}) =>
  send('POST', '/lab-tests/search', body, options);
const add = (body: object, options: Options = {}) => send('POST', '/lab-tests', body, options);
const read = (id: string, options: Options = {}) =>
  app.inject({ url: `/lab-tests/${id}`, headers: headers(options) });
const change = (id: string, body: object, options: Options = {}) =>
  send('PATCH', `/lab-tests/${id}`, body, options);
const act = (id: string, action: 'archive' | 'restore', options: Options = {}) =>
  send('POST', `/lab-tests/${id}/${action}`, undefined, options);
const ranges = (id: string, options: Options = {}) =>
  app.inject({ url: `/lab-tests/${id}/ranges`, headers: headers(options) });
const setRanges = (id: string, rows: unknown[], expectedVersion = 1, options: Options = {}) =>
  send('PUT', `/lab-tests/${id}/ranges`, { ranges: rows, expectedVersion }, options);
const resolve = (id: string, query: string, options: Options = {}) =>
  app.inject({ url: `/lab-tests/${id}/ranges/resolve?${query}`, headers: headers(options) });

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
const names = (response: Response) => response.json<Page>().items.map((item) => item.name);

const age = (value: number, unit: Age['unit']): Age => ({ value, unit });
const BIRTH = age(0, 'days');

const BASE = {
  department: 'biochemistry',
  kind: 'test',
  sampleType: 'serum',
  turnaroundHours: 24,
};

let codes = 0;
/** A code no other test uses. */
const code = () => `T-${String(++codes).padStart(4, '0')}`;

/** Adds a test or a panel and returns it. */
async function added(name: string, more: object = {}, options: Options = {}) {
  const response = await add({ ...BASE, code: code(), name, ...more }, options);
  if (response.statusCode !== 201) throw new Error(`could not add ${name} in test setup`);
  return response.json<LabTest>();
}
const numeric = (name: string, more: object = {}, options: Options = {}) =>
  added(name, { resultType: 'numeric', unit: 'g/dL', ...more }, options);
const panel = (name: string, parts: LabTest[], more: object = {}, options: Options = {}) =>
  added(name, { kind: 'panel', componentIds: parts.map((part) => part.id), ...more }, options);

async function service(tenant: TestTenant, name: string, category: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (tenant_id, code, name, category, tax_class)
     values ($1, $2, $3, $4, 'exempt') returning id`,
    [tenant.id, `S-${randomUUID().slice(0, 8)}`, name, category],
  );
  if (!rows[0]) throw new Error('service was not created');
  return rows[0].id;
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

const cleanUp = async (tenants: TestTenant[]) => {
  const ids = tenants.map((tenant) => tenant.id);
  // None of these cascade from tenants, so the test rows go first, the tests before the services.
  for (const table of ['lab_test_ranges', 'lab_test_components', 'lab_tests', 'services']) {
    await pool.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [ids]);
  }
  await deleteTenants(pool, tenants);
};

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    // This file makes more requests in a minute than one person is allowed.
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { features: { lab_tests: true, services: true } };
  hospital = await createTenant(pool, 'Lab Hospital', on);
  clinic = await createTenant(pool, 'Lab Clinic', on);
  closed = await createTenant(pool, 'Lab Closed', { features: { lab_tests: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Lab Admin', { withPassword: false });
  technician = await createUser(pool, 'Lab Technician', { withPassword: false });
  pharmacist = await createUser(pool, 'Lab Pharmacist', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, technician, hospital, 'lab_technician');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  labService = await service(hospital, 'Haemoglobin test', 'lab');
  otherService = await service(hospital, 'Consultation', 'consultation');
  clinicService = await service(clinic, 'Clinic lab test', 'lab');
});

afterAll(async () => {
  try {
    await cleanUp([hospital, clinic, closed].filter(Boolean));
    await deleteUsers(pool, [admin, technician, pharmacist].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('adding a test', () => {
  it('adds it to the session’s hospital, trimmed, and records who did', async () => {
    const response = await add({
      code: 'HB',
      name: '  Haemoglobin  ',
      department: 'haematology',
      kind: 'test',
      resultType: 'numeric',
      unit: ' g/dL ',
      sampleType: 'blood',
      container: ' EDTA  tube ',
      turnaroundHours: 4,
      serviceId: labService,
    });
    expect(response.statusCode).toBe(201);
    const test = response.json<LabTest>();
    expect(test).toEqual({
      id: test.id,
      tenantId: hospital.id,
      code: 'HB',
      name: 'Haemoglobin',
      department: 'haematology',
      kind: 'test',
      resultType: 'numeric',
      unit: 'g/dL',
      sampleType: 'blood',
      container: 'EDTA tube',
      turnaroundHours: 4,
      serviceId: labService,
      serviceName: 'Haemoglobin test',
      components: [],
      archived: false,
      version: 1,
    });
    expect(await audited(hospital, 'lab_test', test.id)).toEqual(['create']);
    expect(await events(hospital, test.id)).toEqual([{ kind: 'lab_test', change: 'created' }]);
    expect((await ranges(test.id)).json()).toEqual({ labTestId: test.id, ranges: [], version: 1 });
  });

  it('records a result as text unless it is said to be a number', async () => {
    const test = await added('Blood group');
    expect(test).toMatchObject({ resultType: 'text', components: [] });
    expect(test).not.toHaveProperty('unit');
    expect(test).not.toHaveProperty('serviceId');
    expect(test).not.toHaveProperty('serviceName');
  });

  it('refuses a code the hospital already has, whatever its capitals, archived or not', async () => {
    const first = await added('Taken', { code: 'DUP-1' });
    const again = { ...BASE, code: 'dup-1', name: 'Other' };
    expect(errorOf(await add(again))).toEqual([409, 'lab_test_code_taken']);
    await act(first.id, 'archive');
    expect(errorOf(await add(again))).toEqual([409, 'lab_test_code_taken']);
  });

  it('lets one of two simultaneous requests for a new code through', async () => {
    const body = { ...BASE, code: 'RACE-1', name: 'Race' };
    const results = await Promise.all([add(body), add(body)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('answers a repeat of the same request with the same test, and adds one', async () => {
    const body = { ...BASE, code: 'IDEM-1', name: 'Idempotent' };
    const key = `lab-${randomUUID()}`;
    const first = await add(body, { key });
    const second = await add(body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(names(await search({ q: 'IDEM-1' }))).toEqual(['Idempotent']);
  });

  it('is charged as a laboratory service of this hospital and no other', async () => {
    for (const serviceId of [otherService, clinicService, randomUUID(), 'not-an-id']) {
      expect(
        errorOf(await add({ ...BASE, code: code(), name: 'Charged', serviceId })),
        serviceId,
      ).toEqual([400, 'validation_failed']);
    }
    // Empty text is no link.
    const none = await added('Not charged yet', { serviceId: '' });
    expect(none).not.toHaveProperty('serviceId');
  });

  it('needs a code, a name, a section, a kind, a sample and a turnaround it knows', async () => {
    const good = { ...BASE, code: 'OK-1', name: 'Fine' };
    const bad: object[] = [
      { ...good, code: '' },
      { ...good, code: 'has space' },
      { ...good, code: 'x'.repeat(31) },
      { ...good, name: '   ' },
      { ...good, name: 'x'.repeat(151) },
      { ...good, name: 'two\nlines' },
      { ...good, department: 'radiology' },
      { ...good, kind: 'profile' },
      { ...good, resultType: 'image' },
      { ...good, sampleType: 'hair' },
      { ...good, unit: 'x'.repeat(31) },
      { ...good, container: 'x'.repeat(51) },
      { ...good, turnaroundHours: 0 },
      { ...good, turnaroundHours: 721 },
      { ...good, turnaroundHours: null },
      { ...good, turnaroundHours: '24' },
      { code: 'OK-1', name: 'Fine' },
    ];
    for (const body of bad) {
      expect((await add(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(names(await search({ q: 'OK-1' }))).toEqual([]);
  });
});

describe('a panel', () => {
  it('is a set of single tests, reported in the order given, with no result of its own', async () => {
    const [a, b, c] = [
      await numeric('Panel Part A'),
      await added('Panel Part B'),
      await numeric('Panel Part C'),
    ];
    const response = await add({
      ...BASE,
      code: code(),
      name: 'Three Part Panel',
      kind: 'panel',
      // A panel has no result of its own, whatever is sent.
      resultType: 'numeric',
      unit: 'mg/dL',
      componentIds: [c.id, a.id, b.id],
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<LabTest>();
    expect(created).toMatchObject({ kind: 'panel', resultType: 'text' });
    expect(created).not.toHaveProperty('unit');
    expect(created.components).toEqual(
      [c, a, b].map((part) => ({ id: part.id, code: part.code, name: part.name })),
    );
    // The same from a read and from a search.
    expect((await read(created.id)).json<LabTest>().components).toEqual(created.components);
    const found = (await search({ q: 'Three Part Panel' })).json<Page>().items[0];
    expect(found?.components).toEqual(created.components);
  });

  it('has at least one component, none twice, each a single test in use at this hospital', async () => {
    const part = await added('Usable Part');
    const archived = await added('Archived Part');
    await act(archived.id, 'archive');
    const inner = await panel('Inner Panel', [part]);
    const theirs = await added('Clinic Part', {}, { tenant: clinic });

    const body = (componentIds: unknown) => ({
      ...BASE,
      code: code(),
      name: 'Bad Panel',
      kind: 'panel',
      componentIds,
    });
    const bad: unknown[] = [
      undefined,
      [],
      [part.id, part.id],
      [part.id, archived.id],
      [part.id, inner.id],
      [part.id, theirs.id],
      [part.id, randomUUID()],
      [part.id, 'not-an-id'],
      Array.from({ length: 61 }, () => randomUUID()),
      part.id,
    ];
    for (const componentIds of bad) {
      expect((await add(body(componentIds))).statusCode, JSON.stringify(componentIds)).toBe(400);
    }
    expect(names(await search({ q: 'Bad Panel' }))).toEqual([]);
    // And a single test has none.
    expect(
      (await add({ ...BASE, code: code(), name: 'Bad Test', componentIds: [part.id] })).statusCode,
    ).toBe(400);
  });

  it('can have its components changed and put in another order, as one change', async () => {
    const [a, b, c] = [await added('Order A'), await added('Order B'), await added('Order C')];
    const made = await panel('Reordered Panel', [a, b]);

    const response = await change(made.id, { componentIds: [c.id, a.id], expectedVersion: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json<LabTest>().components.map((part) => part.name)).toEqual([
      'Order C',
      'Order A',
    ]);
    expect(response.json<LabTest>().version).toBe(2);
    expect((await events(hospital, made.id)).at(-1)).toEqual({
      kind: 'lab_test',
      change: 'updated',
      fields: ['componentIds'],
    });
    // The same list again changes nothing.
    const again = await change(made.id, { componentIds: [c.id, a.id], expectedVersion: 2 });
    expect(again.json<LabTest>().version).toBe(2);
    // A panel cannot be left with none, and a single test cannot be given any.
    expect((await change(made.id, { componentIds: [], expectedVersion: 2 })).statusCode).toBe(400);
    expect((await change(a.id, { componentIds: [b.id], expectedVersion: 1 })).statusCode).toBe(400);
    expect((await change(a.id, { componentIds: [], expectedVersion: 1 })).json()).toMatchObject({
      version: 1,
    });
  });

  it('keeps a test it is made of from being archived while it is in use', async () => {
    const part = await added('Held Part');
    const holder = await panel('Holding Panel', [part]);
    expect(errorOf(await act(part.id, 'archive'))).toEqual([409, 'lab_test_in_panel']);
    expect((await read(part.id)).json()).toMatchObject({ archived: false, version: 1 });

    // Once the panel is archived, or the test taken out of it, the test can go.
    await act(holder.id, 'archive');
    expect((await act(part.id, 'archive')).json()).toMatchObject({ archived: true });
  });

  it('never ends up made of a test that was archived at the same moment', async () => {
    const part = await added('Contested Part');
    const other = await added('Steady Part');
    const body = {
      ...BASE,
      code: code(),
      name: 'Contested Panel',
      kind: 'panel',
      componentIds: [other.id, part.id],
    };
    const [made, archived] = await Promise.all([add(body), act(part.id, 'archive')]);
    // Either the panel got it and it stays in use, or it was archived and the panel was refused.
    const outcome = [made.statusCode, archived.statusCode];
    expect([
      [201, 409],
      [400, 200],
    ]).toContainEqual(outcome);
    const now = (await read(part.id)).json<LabTest>();
    expect(now.archived).toBe(made.statusCode !== 201);
  });
});

describe('the search', () => {
  let fresh: TestTenant;
  const options = () => ({ tenant: fresh });
  const find = (body: object = {}) => search(body, options());

  beforeAll(async () => {
    // Its own hospital, so the other tests' rows are not in the way.
    fresh = await createTenant(pool, 'Lab Search', { features: { lab_tests: true } });
    await grantRoleDefaults(app, fresh);
    await addMembership(pool, admin, fresh, 'admin');
    const glucose = await numeric('blood glucose', { code: 'GLU' }, options());
    const hb = await numeric('Haemoglobin', { code: 'HB', department: 'haematology' }, options());
    await added('Blood group', { code: 'ABO', department: 'serology' }, options());
    await added('Urine culture', { code: 'UCS', department: 'microbiology' }, options());
    await numeric('zinc', { code: 'ZN' }, options());
    await panel(
      'Anaemia profile',
      [hb, glucose],
      { code: 'ANA', department: 'haematology' },
      options(),
    );
    const old = await added('Old test', { code: 'OLD' }, options());
    await act(old.id, 'archive', options());
  });

  afterAll(async () => {
    await cleanUp([fresh]);
  });

  it('is in name order whatever the capitals, a page at a time, with the total once', async () => {
    const first = await find({ limit: 4 });
    expect(first.statusCode).toBe(200);
    expect(names(first)).toEqual([
      'Anaemia profile',
      'blood glucose',
      'Blood group',
      'Haemoglobin',
    ]);
    const page = first.json<Page>();
    expect(page.total).toBe(6);

    const second = await find({ limit: 4, cursor: page.nextCursor });
    expect(names(second)).toEqual(['Urine culture', 'zinc']);
    expect(second.json<Page>().nextCursor).toBeNull();
    expect(second.json<Page>().total).toBeUndefined();
  });

  it('finds every word of what was typed in the code or the name, in any order', async () => {
    expect(names(await find({ q: 'blood' }))).toEqual(['blood glucose', 'Blood group']);
    expect(names(await find({ q: 'GROUP blood' }))).toEqual(['Blood group']);
    expect(names(await find({ q: 'ucs' }))).toEqual(['Urine culture']);
    expect(names(await find({ q: 'nothing like it' }))).toEqual([]);
    expect(names(await find({ q: '%' }))).toEqual([]);
  });

  it('filters by section and by kind, together and with a cursor', async () => {
    expect(names(await find({ kind: 'panel' }))).toEqual(['Anaemia profile']);
    expect(names(await find({ department: 'serology' }))).toEqual(['Blood group']);
    const body = { department: 'haematology', q: 'a', limit: 1 };
    const first = (await find(body)).json<Page>();
    expect(first.total).toBe(2);
    expect(names(await find({ ...body, cursor: first.nextCursor }))).toEqual(['Haemoglobin']);
    expect(names(await find({ department: 'haematology', kind: 'test' }))).toEqual(['Haemoglobin']);
  });

  it('shows the archived tests only when asked', async () => {
    expect(names(await find({ archived: true }))).toEqual(['Old test']);
    expect(names(await find())).not.toContain('Old test');
  });

  it('refuses a cursor it did not make, and a search it does not understand', async () => {
    const forged = Buffer.from(JSON.stringify({ n: 'a', i: 'not-a-uuid' })).toString('base64url');
    for (const cursor of ['made-up', forged]) {
      expect(errorOf(await find({ cursor }))).toEqual([400, 'invalid_cursor']);
    }
    expect((await find({ limit: 101 })).statusCode).toBe(400);
    expect((await find({ kind: 'profile' })).statusCode).toBe(400);
    expect((await find({ q: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});

describe('changing a test', () => {
  it('saves new details from the version that was read, and says which changed', async () => {
    const test = await numeric('Before', { container: 'Old tube' });
    const response = await change(test.id, {
      name: ' After ',
      department: 'hormones',
      unit: 'mIU/L',
      sampleType: 'plasma',
      container: '',
      turnaroundHours: 48,
      serviceId: labService,
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    const saved = response.json<LabTest>();
    expect(saved).toMatchObject({
      code: test.code,
      name: 'After',
      department: 'hormones',
      unit: 'mIU/L',
      sampleType: 'plasma',
      turnaroundHours: 48,
      serviceId: labService,
      serviceName: 'Haemoglobin test',
      version: 2,
    });
    expect(saved).not.toHaveProperty('container');
    expect(await audited(hospital, 'lab_test', test.id)).toEqual(['create', 'update']);
    expect((await events(hospital, test.id)).at(-1)).toEqual({
      kind: 'lab_test',
      change: 'updated',
      fields: [
        'name',
        'department',
        'unit',
        'sampleType',
        'container',
        'turnaroundHours',
        'serviceId',
      ],
    });
    // Empty text takes the link to the service away again.
    const unlinked = (await change(test.id, { serviceId: '', expectedVersion: 2 })).json<LabTest>();
    expect(unlinked).not.toHaveProperty('serviceId');
    expect(unlinked).not.toHaveProperty('serviceName');
  });

  it('refuses a change made from an older version, and changes nothing', async () => {
    const test = await added('Moved On');
    await change(test.id, { name: 'Moved On Once', expectedVersion: 1 });
    expect(errorOf(await change(test.id, { name: 'Too Late', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    expect((await read(test.id)).json()).toMatchObject({ name: 'Moved On Once', version: 2 });
  });

  it('writes nothing when what is sent is what it already has', async () => {
    const test = await numeric('Same');
    const response = await change(test.id, {
      name: ' Same ',
      unit: 'g/dL',
      resultType: 'numeric',
      expectedVersion: 1,
    });
    expect(response.json()).toMatchObject({ version: 1 });
    expect(await audited(hospital, 'lab_test', test.id)).toEqual(['create']);
  });

  it('never changes the code or the kind, whatever is sent', async () => {
    const test = await added('Fixed');
    const response = await change(test.id, {
      code: 'NEW',
      kind: 'panel',
      name: 'Fixed Renamed',
      expectedVersion: 1,
    });
    expect(response.json()).toMatchObject({ code: test.code, kind: 'test', name: 'Fixed Renamed' });
    for (const set of ["code = 'FORCED'", "kind = 'panel', result_type = 'text'"]) {
      await expect(
        pool.query(`update lab_tests set ${set} where id = $1`, [test.id]),
      ).rejects.toThrow(/cannot be changed/);
    }
  });

  it('lets one of two changes made from the same version through', async () => {
    const test = await added('Contested');
    const results = await Promise.all([
      change(test.id, { name: 'Contested A', expectedVersion: 1 }),
      change(test.id, { name: 'Contested B', expectedVersion: 1 }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('archives and restores, and doing either twice changes nothing', async () => {
    const test = await added('Comes And Goes');
    expect((await act(test.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(test.id, 'archive')).json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(test.id, 'restore')).json()).toMatchObject({ archived: false, version: 3 });
    expect((await act(test.id, 'restore')).json()).toMatchObject({ version: 3 });
    expect(await audited(hospital, 'lab_test', test.id)).toEqual(['create', 'archive', 'restore']);
  });
});

describe('reference ranges', () => {
  const adults: Range[] = [
    { sex: 'male', ageFrom: age(12, 'years'), low: 13, high: 17, criticalLow: 7, criticalHigh: 20 },
    { sex: 'female', ageFrom: age(12, 'years'), low: 12, high: 15, criticalLow: 7 },
    {
      sex: 'any',
      ageFrom: BIRTH,
      ageUntil: age(1, 'months'),
      low: 14,
      high: 22,
      note: ' Newborn ',
    },
    { sex: 'any', ageFrom: age(1, 'months'), ageUntil: age(12, 'years'), low: 11, high: 14 },
  ];

  it('are saved as a set with their own version, and leave the test’s version alone', async () => {
    const test = await numeric('Ranged');
    const response = await setRanges(test.id, adults);
    expect(response.statusCode).toBe(200);
    const saved = response.json<Ranges>();
    expect(saved).toEqual({
      labTestId: test.id,
      ranges: adults.map((row) => (row.note ? { ...row, note: 'Newborn' } : row)),
      version: 2,
    });
    expect((await ranges(test.id)).json()).toEqual(saved);
    expect((await read(test.id)).json()).toMatchObject({ version: 1 });
    expect(await audited(hospital, 'lab_test_ranges', test.id)).toEqual(['update']);
    expect((await events(hospital, test.id)).at(-1)).toEqual({
      kind: 'lab_test_ranges',
      change: 'updated',
    });

    // Saving again replaces them all: none of the old rows is left.
    const fewer = await setRanges(test.id, [adults[0]], 2);
    expect(fewer.json()).toMatchObject({ ranges: [adults[0]], version: 3 });
    expect(errorOf(await setRanges(test.id, adults, 2))).toEqual([409, 'conflict']);
    expect((await setRanges(test.id, [], 3)).json()).toMatchObject({ ranges: [], version: 4 });
  });

  it('belong to a numeric single test only', async () => {
    const text = await added('Text Result');
    const part = await added('Range Panel Part');
    const profile = await panel('Range Panel', [part]);
    for (const test of [text, profile]) {
      expect(errorOf(await setRanges(test.id, adults))).toEqual([409, 'lab_test_has_no_ranges']);
      expect((await ranges(test.id)).json()).toMatchObject({ ranges: [], version: 1 });
    }
  });

  it('keep a test numeric until they are removed', async () => {
    const test = await numeric('Stays Numeric');
    await setRanges(test.id, [adults[0]]);
    expect(errorOf(await change(test.id, { resultType: 'text', expectedVersion: 1 }))).toEqual([
      409,
      'lab_test_has_ranges',
    ]);
    await setRanges(test.id, [], 2);
    expect(
      (await change(test.id, { resultType: 'text', expectedVersion: 1 })).json(),
    ).toMatchObject({ resultType: 'text', version: 2 });
  });

  it('refuse a row that says nothing, contradicts itself or cannot be reached', async () => {
    const test = await numeric('Strict Ranges');
    const row = { sex: 'any', ageFrom: BIRTH };
    const bad: unknown[] = [
      // No limit at all.
      row,
      { ...row, low: 5, high: 5 },
      { ...row, low: 6, high: 5 },
      // A critical limit inside the normal range.
      { ...row, low: 5, high: 9, criticalLow: 6 },
      { ...row, low: 5, high: 9, criticalHigh: 8 },
      { ...row, high: 9, criticalLow: 10 },
      { ...row, low: 5, criticalHigh: 4 },
      // An end that is not after the start for every date of birth.
      { ...row, ageFrom: age(1, 'years'), ageUntil: age(12, 'months'), low: 1 },
      { ...row, ageFrom: age(1, 'months'), ageUntil: age(30, 'days'), low: 1 },
      // Older than anyone, in its unit.
      { ...row, ageFrom: age(151, 'years'), low: 1 },
      { ...row, ageUntil: age(1801, 'months'), low: 1 },
      // Not a number: never read as 0.
      { ...row, low: null, high: 5 },
      { ...row, low: '4', high: 5 },
      { ...row, low: true, high: 5 },
      { ...row, ageFrom: { value: null, unit: 'days' }, low: 1 },
      { ...row, ageFrom: { value: 1.5, unit: 'days' }, low: 1 },
      { ...row, ageFrom: { value: 1, unit: 'hours' }, low: 1 },
      { sex: 'other', ageFrom: BIRTH, low: 1 },
      { ...row, low: 1, note: 'x'.repeat(151) },
      { ...row, low: 1, extra: 1, ageFrom: undefined },
    ];
    for (const range of bad) {
      expect((await setRanges(test.id, [range])).statusCode, JSON.stringify(range)).toBe(400);
    }
    const tooMany = Array.from({ length: 61 }, (_, year) => ({
      sex: 'any',
      ageFrom: age(year, 'years'),
      ageUntil: age(year + 1, 'years'),
      low: 1,
    }));
    expect((await setRanges(test.id, tooMany)).statusCode).toBe(400);
    expect((await ranges(test.id)).json()).toMatchObject({ ranges: [], version: 1 });
  });

  it('never let two rows for the same people both hold, for any date of birth', async () => {
    const test = await numeric('Overlaps');
    const band = (sex: string, from: Age, until?: Age) => ({
      sex,
      ageFrom: from,
      ...(until ? { ageUntil: until } : {}),
      low: 1,
    });
    const refused: unknown[][] = [
      [band('any', BIRTH), band('any', age(1, 'years'))],
      [band('male', BIRTH, age(2, 'years')), band('male', age(1, 'years'))],
      // A month is 28 to 31 days: some dates of birth bring these together.
      [band('any', BIRTH, age(1, 'months')), band('any', age(30, 'days'))],
      [band('any', BIRTH, age(1, 'months')), band('any', age(4, 'weeks'))],
    ];
    for (const rows of refused) {
      expect((await setRanges(test.id, rows)).statusCode, JSON.stringify(rows)).toBe(400);
    }
    const accepted: unknown[][] = [
      // Ranges that meet give the age in the same unit, or in units that compare exactly.
      [band('any', BIRTH, age(1, 'months')), band('any', age(1, 'months'))],
      [band('any', BIRTH, age(12, 'months')), band('any', age(1, 'years'))],
      [band('any', BIRTH, age(4, 'weeks')), band('any', age(28, 'days'))],
      // No date of birth brings these together.
      [band('any', BIRTH, age(1, 'months')), band('any', age(31, 'days'))],
      // A row for one sex and a row for anyone may share ages.
      [band('any', BIRTH), band('male', BIRTH), band('female', age(12, 'years'))],
    ];
    let version = 1;
    for (const rows of accepted) {
      const response = await setRanges(test.id, rows, version);
      expect(response.statusCode, JSON.stringify(rows)).toBe(200);
      version = response.json<Ranges>().version;
    }
  });

  it('say which row applies to a patient of an age and a sex', async () => {
    const test = await numeric('Resolved');
    await setRanges(test.id, adults);
    const lowFor = async (query: string) =>
      (await resolve(test.id, query)).json<{ range?: Range }>().range?.low;

    // The row for the patient's sex comes before the row for anyone.
    expect(await lowFor('ageValue=30&ageUnit=years&sex=male')).toBe(13);
    expect(await lowFor('ageValue=30&ageUnit=years&sex=female')).toBe(12);
    // A patient recorded as other gets only a row for anyone, and here there is none for adults.
    expect((await resolve(test.id, 'ageValue=30&ageUnit=years&sex=other')).json()).toEqual({});
    expect(await lowFor('ageValue=5&ageUnit=years&sex=other')).toBe(11);
    // From an age, included, until an age, not included.
    expect(await lowFor('ageValue=0&ageUnit=days&sex=male')).toBe(14);
    expect(await lowFor('ageValue=1&ageUnit=months&sex=male')).toBe(11);
    expect(await lowFor('ageValue=12&ageUnit=years&sex=male')).toBe(13);
    expect(await lowFor('ageValue=143&ageUnit=months&sex=male')).toBe(11);
    // Thirty days is under a month for someone born on 1 January, and thirty-one is not.
    expect(await lowFor('ageValue=30&ageUnit=days&sex=female')).toBe(14);
    expect(await lowFor('ageValue=31&ageUnit=days&sex=female')).toBe(11);
    expect(await lowFor('ageValue=4&ageUnit=weeks&sex=female')).toBe(14);
  });

  it('refuse a question about an age or a sex they do not understand', async () => {
    const test = await numeric('Asked Badly');
    for (const query of [
      '',
      'ageValue=5&ageUnit=years',
      'ageValue=&ageUnit=years&sex=male',
      'ageValue=five&ageUnit=years&sex=male',
      'ageValue=-1&ageUnit=years&sex=male',
      'ageValue=151&ageUnit=years&sex=male',
      'ageValue=5&ageUnit=hours&sex=male',
      'ageValue=5&ageUnit=years&sex=any',
    ]) {
      expect((await resolve(test.id, query)).statusCode, query).toBe(400);
    }
    // A test with no ranges, a text test and a panel have no row for anyone.
    expect((await resolve(test.id, 'ageValue=5&ageUnit=years&sex=male')).json()).toEqual({});
  });
});

describe('access', () => {
  it('lets someone who may only read see tests and ranges and change nothing', async () => {
    const test = await numeric('Read Only');
    const options = { user: technician };
    expect((await search({}, options)).statusCode).toBe(200);
    expect((await read(test.id, options)).statusCode).toBe(200);
    expect((await ranges(test.id, options)).statusCode).toBe(200);
    expect((await resolve(test.id, 'ageValue=5&ageUnit=years&sex=male', options)).statusCode).toBe(
      200,
    );

    const denied = [403, 'permission_denied'];
    expect(errorOf(await add({ ...BASE, code: 'NO', name: 'No' }, options))).toEqual(denied);
    expect(errorOf(await change(test.id, { name: 'No', expectedVersion: 1 }, options))).toEqual(
      denied,
    );
    expect(errorOf(await act(test.id, 'archive', options))).toEqual(denied);
    expect(errorOf(await setRanges(test.id, [], 1, options))).toEqual(denied);
  });

  it('shows the name of the service a test is charged as, and nothing else of it', async () => {
    // A lab technician holds no permission on the price catalog here.
    await pool.query(
      "delete from role_permissions where tenant_id = $1 and role_id = 'lab_technician' and permission like 'service:%'",
      [hospital.id],
    );
    const test = await added('Charged And Shown', { serviceId: labService });
    const seen = (await read(test.id, { user: technician })).json<LabTest>();
    expect(seen).toMatchObject({ serviceId: labService, serviceName: 'Haemoglobin test' });
    expect(JSON.stringify(seen)).not.toMatch(/price|taxClass|amount/i);
  });

  it('shows nothing to a role without the permission', async () => {
    expect(errorOf(await search({}, { user: pharmacist }))).toEqual([403, 'permission_denied']);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };
    expect(errorOf(await search({}, options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await add({ ...BASE, code: 'X', name: 'X' }, options))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/lab-tests/search', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('keeps each hospital’s tests to itself, and lets both use a code', async () => {
    const ours = await added('Shared Code', { code: 'BOTH-1' });
    const theirs = await added('Shared Code', { code: 'BOTH-1' }, { tenant: clinic });
    expect(theirs.tenantId).toBe(clinic.id);
    const seen = (await search({ q: 'BOTH-1' }, { tenant: clinic })).json<Page>().items;
    expect(seen.map((item) => item.id)).toEqual([theirs.id]);
    expect((await search({ q: 'BOTH-1' })).json<Page>().items.map((item) => item.id)).toEqual([
      ours.id,
    ]);
  });

  it('has one answer for another hospital’s test and one that does not exist', async () => {
    const theirs = await numeric('Clinic Only', {}, { tenant: clinic });
    await setRanges(theirs.id, [{ sex: 'any', ageFrom: BIRTH, low: 1 }], 1, { tenant: clinic });
    const missing = [404, 'lab_test_not_found'];
    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await read(id)), id).toEqual(missing);
      expect(errorOf(await change(id, { name: 'Taken', expectedVersion: 1 })), id).toEqual(missing);
      expect(errorOf(await act(id, 'archive')), id).toEqual(missing);
      expect(errorOf(await ranges(id)), id).toEqual(missing);
      expect(errorOf(await setRanges(id, [], 2)), id).toEqual(missing);
      expect(errorOf(await resolve(id, 'ageValue=5&ageUnit=years&sex=male')), id).toEqual(missing);
    }
    expect((await ranges(theirs.id, { tenant: clinic })).json()).toMatchObject({ version: 2 });
  });

  it('is kept apart, and held to its rules, by the database itself', async () => {
    const theirs = await numeric('Clinic Secret', {}, { tenant: clinic });
    await setRanges(theirs.id, [{ sex: 'any', ageFrom: BIRTH, low: 1 }], 1, { tenant: clinic });
    const theirPart = await added('Clinic Part For Panel', {}, { tenant: clinic });
    await panel('Clinic Panel', [theirPart], {}, { tenant: clinic });
    const ours = await numeric('Hospital Own');
    const text = await added('Hospital Text');
    const ourPart = await added('Hospital Part');
    const ourPanel = await panel('Hospital Panel', [ourPart]);
    await setRanges(ours.id, [{ sex: 'any', ageFrom: BIRTH, low: 1 }]);

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      test: (await client.query('select 1 from lab_tests where id = $1', [theirs.id])).rowCount,
      updated: (
        await client.query("update lab_tests set name = 'Stolen' where id = $1", [theirs.id])
      ).rowCount,
      tenants: (
        await client.query<{ tenant_id: string }>(
          `select distinct tenant_id from lab_tests
           union select distinct tenant_id from lab_test_components
           union select distinct tenant_id from lab_test_ranges`,
        )
      ).rows,
    }));
    expect(seen).toEqual({ test: 0, updated: 0, tenants: [{ tenant_id: hospital.id }] });

    const sql = (text_: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text_, params));
    const range = `insert into lab_test_ranges
        (tenant_id, lab_test_id, position, sex, age_from_value, age_from_unit, low, high, critical_low)
      values ($1, $2, 5, 'any', 0, 'days', $3, $4, $5)`;
    const component = `insert into lab_test_components (tenant_id, panel_id, component_id, position)
      values ($1, $2, $3, 9)`;

    // Nor can a hospital put a test into another, or delete its own.
    await expect(
      sql(
        `insert into lab_tests (tenant_id, code, name, department, kind, result_type, sample_type, turnaround_hours)
         values ($1, 'PLANTED', 'Planted', 'other', 'test', 'text', 'blood', 1)`,
        [clinic.id],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(sql('delete from lab_tests where id = $1', [ours.id])).rejects.toThrow(
      /permission denied/,
    );
    // A test is charged as a service of its own hospital: the reference carries the hospital.
    await expect(
      sql('update lab_tests set service_id = $2 where id = $1', [ours.id, clinicService]),
    ).rejects.toThrow(/lab_tests_service/);
    // A panel is made of single tests of its own hospital.
    await expect(sql(component, [hospital.id, ourPanel.id, theirPart.id])).rejects.toThrow(
      /single tests|lab_test_components_component/,
    );
    await expect(sql(component, [hospital.id, ourPart.id, ours.id])).rejects.toThrow(
      /single tests/,
    );
    await expect(sql(component, [hospital.id, ourPanel.id, ourPanel.id])).rejects.toThrow(
      /single tests/,
    );
    // Only a numeric test has ranges, and a range says something that can be true.
    await expect(sql(range, [hospital.id, text.id, 1, 2, null])).rejects.toThrow(/numeric test/);
    await expect(sql(range, [hospital.id, theirs.id, 1, 2, null])).rejects.toThrow(
      /numeric test|lab_test_ranges_test/,
    );
    await expect(sql(range, [hospital.id, ours.id, null, null, null])).rejects.toThrow(
      /lab_test_ranges_has_a_limit/,
    );
    await expect(sql(range, [hospital.id, ours.id, 5, 4, null])).rejects.toThrow(
      /lab_test_ranges_low_below_high/,
    );
    await expect(sql(range, [hospital.id, ours.id, 5, 9, 6])).rejects.toThrow(
      /lab_test_ranges_critical_low/,
    );
    // A test with ranges stays numeric, and a panel has no result of its own.
    await expect(
      sql("update lab_tests set result_type = 'text' where id = $1", [ours.id]),
    ).rejects.toThrow(/stays numeric/);
    await expect(
      sql("update lab_tests set result_type = 'numeric' where id = $1", [ourPanel.id]),
    ).rejects.toThrow(/lab_tests_panel_has_no_result/);
    // Each of the two versions is the database's to count.
    const { rows } = await pool.query<{ version: number; ranges_version: number }>(
      `update lab_tests set name = 'Counted', version = 99 where id = $1
       returning version, ranges_version`,
      [text.id],
    );
    expect(rows[0]).toEqual({ version: 2, ranges_version: 1 });
  });
});

describe('found in review', () => {
  const adult: Range = { sex: 'any', ageFrom: BIRTH, low: 70, high: 100, criticalLow: 40 };

  it('keeps the unit of a test that has reference ranges, as it keeps it numeric', async () => {
    const test = await numeric('Review Unit', { unit: 'mg/dL' });
    await setRanges(test.id, [adult]);
    // The ranges are numbers in mg/dL: they do not stand for a test in another unit, or in none.
    for (const unit of ['mmol/L', '']) {
      expect(errorOf(await change(test.id, { unit, expectedVersion: 1 })), unit).toEqual([
        409,
        'lab_test_has_ranges',
      ]);
    }
    expect((await read(test.id)).json()).toMatchObject({ unit: 'mg/dL', version: 1 });
    expect((await ranges(test.id)).json<Ranges>().ranges).toEqual([adult]);
    // The same unit, and everything else, still changes; and the database holds the rule too.
    const renamed = await change(test.id, {
      name: 'Review Unit Renamed',
      unit: ' mg/dL ',
      expectedVersion: 1,
    });
    expect(renamed.json()).toMatchObject({ unit: 'mg/dL', version: 2 });
    await expect(
      pool.query("update lab_tests set unit = 'mmol/L' where id = $1", [test.id]),
    ).rejects.toThrow(/keeps its unit/);
    // Once the ranges are removed the unit can change, and new ranges be entered for it.
    await setRanges(test.id, [], 2);
    expect((await change(test.id, { unit: 'mmol/L', expectedVersion: 2 })).json()).toMatchObject({
      unit: 'mmol/L',
      version: 3,
    });
  });

  it('does not bring back a panel while a test it is made of is archived', async () => {
    const part = await added('Review Part Gone');
    const other = await added('Review Part Stays');
    const made = await panel('Review Panel Back', [part, other]);
    await act(made.id, 'archive');
    await act(part.id, 'archive');

    expect(errorOf(await act(made.id, 'restore'))).toEqual([409, 'lab_test_component_archived']);
    expect((await read(made.id)).json()).toMatchObject({ archived: true, version: 2 });
    // Its details can still be changed with the list it has, which is not looked at again.
    const renamed = await change(made.id, {
      name: 'Review Panel Renamed',
      componentIds: [part.id, other.id],
      expectedVersion: 2,
    });
    expect(renamed.json()).toMatchObject({ name: 'Review Panel Renamed', version: 3 });
    // Take the archived test out, and the panel comes back.
    await change(made.id, { componentIds: [other.id], expectedVersion: 3 });
    expect((await act(made.id, 'restore')).json()).toMatchObject({ archived: false });
    expect((await events(hospital, made.id)).map((payload) => payload.change)).toEqual([
      'created',
      'archived',
      'updated',
      'updated',
      'restored',
    ]);
  });

  it('gives a panel no result of its own on a change either', async () => {
    const part = await added('Review Panel Part');
    const made = await panel('Review Panel Result', [part]);
    const response = await change(made.id, {
      resultType: 'numeric',
      unit: 'mg/dL',
      name: 'Review Panel Result Renamed',
      expectedVersion: 1,
    });
    const saved = response.json<LabTest>();
    expect(saved).toMatchObject({ resultType: 'text', name: 'Review Panel Result Renamed' });
    expect(saved).not.toHaveProperty('unit');
    expect((await events(hospital, made.id)).at(-1)).toMatchObject({ fields: ['name'] });
  });

  it('answers two panels that name each other with a refusal each, never a failure', async () => {
    const [a, b] = [await added('Review Loop A'), await added('Review Loop B')];
    const [first, second] = [
      await panel('Review Loop One', [a]),
      await panel('Review Loop Two', [b]),
    ];
    const results = await Promise.all([
      change(first.id, { componentIds: [a.id, second.id], expectedVersion: 1 }),
      change(second.id, { componentIds: [b.id, first.id], expectedVersion: 1 }),
    ]);
    expect(results.map((response) => response.statusCode)).toEqual([400, 400]);
  });

  it('never adds to a panel a test that was archived at the same moment', async () => {
    const part = await added('Review Late Part');
    const base = await added('Review Base Part');
    const made = await panel('Review Late Panel', [base]);
    const [changed, archived] = await Promise.all([
      change(made.id, { componentIds: [base.id, part.id], expectedVersion: 1 }),
      act(part.id, 'archive'),
    ]);
    expect([
      [200, 409],
      [400, 200],
    ]).toContainEqual([changed.statusCode, archived.statusCode]);
    const now = (await read(part.id)).json<LabTest>();
    expect(now.archived).toBe(changed.statusCode !== 200);
  });

  it('lets one of two saves of the ranges made from the same version through', async () => {
    const test = await numeric('Review Two Saves');
    const results = await Promise.all([
      setRanges(test.id, [adult]),
      setRanges(test.id, [{ ...adult, low: 60 }]),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await ranges(test.id)).json()).toMatchObject({ version: 2 });
  });

  it('never leaves a text test with ranges, whichever of the two changes comes first', async () => {
    const test = await numeric('Review Text Race');
    const [toText, saved] = await Promise.all([
      change(test.id, { resultType: 'text', expectedVersion: 1 }),
      setRanges(test.id, [adult]),
    ]);
    // Either it became text and the ranges were refused, or it has ranges and stayed numeric.
    expect([
      [200, 409],
      [409, 200],
    ]).toContainEqual([toText.statusCode, saved.statusCode]);
    const now = (await read(test.id)).json<LabTest>();
    const held = (await ranges(test.id)).json<Ranges>().ranges;
    expect(now.resultType === 'numeric' || held.length === 0).toBe(true);
  });

  it('links a test to a service that is in use, and leaves a link it already has alone', async () => {
    const retired = await service(hospital, 'Retired lab service', 'lab');
    const test = await added('Review Linked', { serviceId: retired });
    await pool.query('update services set archived = true where id = $1', [retired]);

    // The link stays, and a change that names it again is not a new link.
    const renamed = await change(test.id, {
      name: 'Review Linked Renamed',
      serviceId: retired.toUpperCase(),
      expectedVersion: 1,
    });
    expect(renamed.json()).toMatchObject({ serviceId: retired, version: 2 });
    expect((await events(hospital, test.id)).at(-1)).toMatchObject({ fields: ['name'] });
    // But no test is newly linked to an archived service.
    expect(
      (await add({ ...BASE, code: code(), name: 'Review New Link', serviceId: retired }))
        .statusCode,
    ).toBe(400);
    const other = await added('Review Other');
    expect((await change(other.id, { serviceId: retired, expectedVersion: 1 })).statusCode).toBe(
      400,
    );
  });

  it('stores text in one form, and refuses what would not read as it was typed', async () => {
    const test = await added('Review Café  test ', { container: 'Gel  tube' });
    expect(test).toMatchObject({ name: 'Review Café test', container: 'Gel tube' });
    const good = { ...BASE, code: 'RV-TEXT', name: 'Review Text' };
    const bad: object[] = [
      { ...good, name: 'zero​width' },
      { ...good, name: 'over‮ride' },
      { ...good, unit: 'g\u0000dL' },
      { ...good, container: 'a\ttube' },
      // Long enough only once it is in its normal form.
      { ...good, name: 'क़'.repeat(100) },
      { ...good, unit: 'क़'.repeat(20), resultType: 'numeric' },
    ];
    for (const body of bad) {
      expect((await add(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await search({ q: 'zero​width' })).statusCode).toBe(400);
    const ranged = await numeric('Review Note');
    for (const note of ['two\nlines', 'क़'.repeat(100)]) {
      expect((await setRanges(ranged.id, [{ ...adult, note }])).statusCode).toBe(400);
    }
  });

  it('takes what was typed in a search as text, whatever it holds', async () => {
    await added('Review 100% under_score back\\slash');
    for (const q of ['100%', 'under_score', 'back\\slash']) {
      expect(names(await search({ q: `Review ${q}` })), q).toEqual([
        'Review 100% under_score back\\slash',
      ]);
    }
    expect(names(await search({ q: 'Review under.score' }))).toEqual([]);
    expect(names(await search({ q: 'Review _' }))).toEqual(['Review 100% under_score back\\slash']);
  });

  it('takes an age up to 150 years in any unit, and a limit of any size a screen can show', async () => {
    const test = await numeric('Review Edges');
    const oldest: Range[] = [
      { sex: 'male', ageFrom: age(150, 'years'), low: -999999999 },
      { sex: 'female', ageFrom: age(1800, 'months'), high: 999999999 },
      { sex: 'any', ageFrom: age(54750, 'days'), low: 0.001, high: 0.002 },
    ];
    expect((await setRanges(test.id, oldest)).json<Ranges>().ranges).toEqual(oldest);
    for (const limit of [1e9, -1e9, 1e21]) {
      expect(
        (await setRanges(test.id, [{ sex: 'any', ageFrom: BIRTH, low: limit }], 2)).statusCode,
        String(limit),
      ).toBe(400);
    }
    expect((await resolve(test.id, 'ageValue=150&ageUnit=years&sex=male')).json()).toEqual({
      range: oldest[0],
    });
  });
});
