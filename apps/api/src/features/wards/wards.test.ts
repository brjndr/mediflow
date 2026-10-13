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
 * The wards API through the real app and database: bed categories, wards, rooms and beds; the
 * status of a bed; what cannot be archived; the hospital boundary, permissions, audit and events.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the wards module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Sees wards, cannot change them. */
let nurse: TestUser;
/** No ward permissions at all. */
let pharmacist: TestUser;
/** A bed-day service and a laboratory service of the hospital, and a bed-day service of the clinic. */
let bedService: string;
let labService: string;
let clinicBedService: string;
let department: string;
let clinicDepartment: string;
/** A category to give beds, at each hospital. */
let general: string;
let clinicGeneral: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Category {
  id: string;
  tenantId: string;
  name: string;
  serviceId?: string;
  serviceName?: string;
  bedCount: number;
  archived: boolean;
  version: number;
}
interface Ward {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  floor?: string;
  departmentId?: string;
  departmentName?: string;
  roomCount: number;
  bedCount: number;
  archived: boolean;
  version: number;
}
interface Bed {
  id: string;
  roomId: string;
  number: string;
  bedCategoryId: string;
  bedCategoryName: string;
  status: string;
  blockedReason?: string;
  blockedNote?: string;
  archived: boolean;
  version: number;
}
interface Room {
  id: string;
  name: string;
  beds: Bed[];
  archived: boolean;
  version: number;
}
interface Detail {
  ward: Ward;
  rooms: Room[];
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
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const send = (method: 'POST' | 'PATCH', url: string, body?: object, options: Options = {}) =>
  app.inject({ method, url, headers: headers(options), ...(body ? { payload: body } : {}) });
const post = (url: string, body?: object, options: Options = {}) =>
  send('POST', url, body, options);
const patch = (url: string, body: object, options: Options = {}) =>
  send('PATCH', url, body, options);

const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];

let codes = 0;
/** A code or a name no other test uses. */
const unique = (prefix: string) => `${prefix}-${String(++codes).padStart(4, '0')}`;

async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}

const addCategory = async (name = unique('Category'), more: object = {}, options: Options = {}) =>
  ok<Category>(await post('/bed-categories', { name, ...more }, options), 201);
const addWard = async (more: object = {}, options: Options = {}) =>
  ok<Detail>(
    await post('/wards', { code: unique('W'), name: unique('Ward'), ...more }, options),
    201,
  );
const addRoom = async (wardId: string, name = unique('Room'), options: Options = {}) =>
  ok<Detail>(await post(`/wards/${wardId}/rooms`, { name }, options), 201);
const read = async (wardId: string, options: Options = {}) =>
  ok<Detail>(await get(`/wards/${wardId}`, options));

/** A ward with one room, and a helper to add beds to it and find them again. */
async function wardWithRoom(options: Options = {}) {
  const tenant = options.tenant ?? hospital;
  const { ward } = await addWard({}, options);
  const withRoom = await addRoom(ward.id, 'Room 1', options);
  const room = withRoom.rooms[0];
  if (!room) throw new Error('no room');
  const categoryId = tenant.id === clinic.id ? clinicGeneral : general;
  const addBed = async (number: string, bedCategoryId = categoryId) => {
    const detail = await ok<Detail>(
      await post(`/wards/${ward.id}/rooms/${room.id}/beds`, { number, bedCategoryId }, options),
      201,
    );
    const bed = detail.rooms.flatMap((each) => each.beds).find((each) => each.number === number);
    if (!bed) throw new Error('no bed');
    return bed;
  };
  const bed = async (id: string) => {
    const found = (await read(ward.id, options)).rooms
      .flatMap((each) => each.beds)
      .find((each) => each.id === id);
    if (!found) throw new Error('bed not found');
    return found;
  };
  const act = (bedId: string, action: string, body?: object) =>
    post(`/wards/${ward.id}/beds/${bedId}/${action}`, body, options);
  return { ward, room, addBed, bed, act };
}

/** What admissions and housekeeping will do: set a bed occupied, or being cleaned. */
const setStatus = (bedId: string, status: string) =>
  pool.query('update beds set status = $2 where id = $1', [bedId, status]);

async function service(tenant: TestTenant, name: string, category: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into services (tenant_id, code, name, category, tax_class)
     values ($1, $2, $3, $4, 'standard') returning id`,
    [tenant.id, `S-${randomUUID().slice(0, 8)}`, name, category],
  );
  if (!rows[0]) throw new Error('service was not created');
  return rows[0].id;
}

async function departmentOf(tenant: TestTenant, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'insert into departments (tenant_id, name) values ($1, $2) returning id',
    [tenant.id, name],
  );
  if (!rows[0]) throw new Error('department was not created');
  return rows[0].id;
}

const audited = async (entity: string, entityId: string, tenant = hospital) => {
  const { rows } = await pool.query<{ action: string }>(
    `select action from audit_log
     where tenant_id = $1 and entity = $2 and entity_id = $3 order by at`,
    [tenant.id, entity, entityId],
  );
  return rows.map((row) => row.action);
};

const events = async (entityId: string, tenant = hospital) => {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from outbox
     where tenant_id = $1 and event = 'master.changed' and entity_id = $2 order by occurred_at, id`,
    [tenant.id, entityId],
  );
  return rows.map((row) => row.payload);
};

const cleanUp = async (tenants: TestTenant[]) => {
  const ids = tenants.map((tenant) => tenant.id);
  // None of these cascade from tenants, so the test rows go first, each before what it names.
  for (const table of ['beds', 'rooms', 'wards', 'bed_categories', 'services', 'departments']) {
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
  const on = { features: { wards: true, services: true, departments: true } };
  hospital = await createTenant(pool, 'Wards Hospital', on);
  clinic = await createTenant(pool, 'Wards Clinic', on);
  closed = await createTenant(pool, 'Wards Closed', { features: { wards: false } });
  const tenants = [hospital, clinic, closed];
  for (const tenant of tenants) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Wards Admin', { withPassword: false });
  nurse = await createUser(pool, 'Wards Nurse', { withPassword: false });
  pharmacist = await createUser(pool, 'Wards Pharmacist', { withPassword: false });
  for (const tenant of tenants) await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  bedService = await service(hospital, 'General ward bed day', 'bed');
  labService = await service(hospital, 'Blood count', 'lab');
  clinicBedService = await service(clinic, 'Clinic bed day', 'bed');
  department = await departmentOf(hospital, 'General Medicine');
  clinicDepartment = await departmentOf(clinic, 'Clinic Medicine');
  general = (await addCategory('General ward', { serviceId: bedService })).id;
  clinicGeneral = (await addCategory('General ward', {}, { tenant: clinic })).id;
});

afterAll(async () => {
  try {
    await cleanUp([hospital, clinic, closed].filter(Boolean));
    await deleteUsers(pool, [admin, nurse, pharmacist].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('bed categories', () => {
  it('are added at the session’s hospital, charged as a bed-day service, and audited', async () => {
    const category = await addCategory('  Private  room ', { serviceId: bedService });
    expect(category).toEqual({
      id: category.id,
      tenantId: hospital.id,
      name: 'Private room',
      serviceId: bedService,
      serviceName: 'General ward bed day',
      bedCount: 0,
      archived: false,
      version: 1,
    });
    expect(await audited('bed_category', category.id)).toEqual(['create']);
    expect(await events(category.id)).toEqual([{ kind: 'bed_category', change: 'created' }]);
  });

  it('refuse a name the hospital has, whatever its capitals, and a service that is not a bed day here', async () => {
    await addCategory('Taken Category');
    expect(errorOf(await post('/bed-categories', { name: 'TAKEN category' }))).toEqual([
      409,
      'bed_category_name_taken',
    ]);
    const results = await Promise.all([
      post('/bed-categories', { name: 'Category Race' }),
      post('/bed-categories', { name: 'Category Race' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    for (const serviceId of [labService, clinicBedService, randomUUID(), 'not-an-id']) {
      expect(
        (await post('/bed-categories', { name: unique('Category'), serviceId })).statusCode,
        serviceId,
      ).toBe(400);
    }
    for (const body of [{}, { name: '  ' }, { name: 'x'.repeat(101) }, { name: 'a\nb' }]) {
      expect((await post('/bed-categories', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('answer a repeat of the same request with the same category', async () => {
    const key = `wards-${randomUUID()}`;
    const body = { name: 'Category Once' };
    const first = await post('/bed-categories', body, { key });
    const second = await post('/bed-categories', body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('are changed from the version that was read, and keep a service that was archived since', async () => {
    const retired = await service(hospital, 'Retired bed day', 'bed');
    const category = await addCategory('Before Category', { serviceId: retired });
    await pool.query('update services set archived = true where id = $1', [retired]);
    const url = `/bed-categories/${category.id}`;

    // The service it has stays, and is not a new link when it is named again.
    const renamed = await patch(url, {
      name: 'After Category',
      serviceId: retired,
      expectedVersion: 1,
    });
    expect(renamed.json()).toMatchObject({
      name: 'After Category',
      serviceId: retired,
      version: 2,
    });
    expect(errorOf(await patch(url, { name: 'Late', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    // What it already has changes nothing.
    expect(
      (await patch(url, { name: ' After Category ', expectedVersion: 2 })).json(),
    ).toMatchObject({ version: 2 });
    // Another service, and none.
    const moved = await patch(url, { serviceId: bedService, expectedVersion: 2 });
    expect(moved.json()).toMatchObject({ serviceId: bedService, version: 3 });
    expect(errorOf(await patch(url, { serviceId: retired, expectedVersion: 3 }))).toEqual([
      400,
      'validation_failed',
    ]);
    const unlinked = (await patch(url, { serviceId: '', expectedVersion: 3 })).json<Category>();
    expect(unlinked).not.toHaveProperty('serviceId');
    expect(unlinked).not.toHaveProperty('serviceName');
    expect(errorOf(await patch(url, { name: 'General ward', expectedVersion: 4 }))).toEqual([
      409,
      'bed_category_name_taken',
    ]);
    expect(await audited('bed_category', category.id)).toEqual([
      'create',
      'update',
      'update',
      'update',
    ]);
  });

  it('count the beds in use that have them, and are not archived while one has', async () => {
    const category = await addCategory();
    const { ward, room, addBed, act } = await wardWithRoom();
    const first = await addBed('C1', category.id);
    await addBed('C2', category.id);
    const count = async () =>
      (await ok<Page<Category>>(await get('/bed-categories?limit=100'))).items.find(
        (item) => item.id === category.id,
      )?.bedCount;
    expect(await count()).toBe(2);
    expect(errorOf(await post(`/bed-categories/${category.id}/archive`))).toEqual([
      409,
      'bed_category_in_use',
    ]);

    // An archived bed, and a bed of an archived room, are not in use.
    await act(first.id, 'archive');
    expect(await count()).toBe(1);
    await post(`/wards/${ward.id}/rooms/${room.id}/archive`);
    expect(await count()).toBe(0);
    const archived = await post(`/bed-categories/${category.id}/archive`);
    expect(archived.json()).toMatchObject({ archived: true, version: 2 });
    expect((await post(`/bed-categories/${category.id}/archive`)).json()).toMatchObject({
      version: 2,
    });

    // A bed does not come back, and none is added, with an archived category.
    await post(`/wards/${ward.id}/rooms/${room.id}/restore`);
    expect(errorOf(await act(first.id, 'restore'))).toEqual([409, 'bed_category_archived']);
    expect(
      (
        await post(`/wards/${ward.id}/rooms/${room.id}/beds`, {
          number: 'C3',
          bedCategoryId: category.id,
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(`/bed-categories/${category.id}/restore`)).json()).toMatchObject({
      archived: false,
      version: 3,
    });
    expect((await act(first.id, 'restore')).statusCode).toBe(200);
  });

  it('are listed by name, a page at a time, the archived ones only when asked', async () => {
    const fresh = await createTenant(pool, 'Wards Categories', { features: { wards: true } });
    await grantRoleDefaults(app, fresh);
    await addMembership(pool, admin, fresh, 'admin');
    const options = { tenant: fresh };
    try {
      for (const name of ['private', 'General', 'ICU']) await addCategory(name, {}, options);
      const old = await addCategory('Old', {}, options);
      await post(`/bed-categories/${old.id}/archive`, undefined, options);

      const first = await ok<Page<Category>>(await get('/bed-categories?limit=2', options));
      expect(first.items.map((item) => item.name)).toEqual(['General', 'ICU']);
      expect(first.total).toBe(3);
      const second = await ok<Page<Category>>(
        await get(`/bed-categories?limit=2&cursor=${first.nextCursor}`, options),
      );
      expect(second.items.map((item) => item.name)).toEqual(['private']);
      expect(second.nextCursor).toBeNull();
      expect(second.total).toBeUndefined();
      const archived = await ok<Page<Category>>(
        await get('/bed-categories?archived=true', options),
      );
      expect(archived.items.map((item) => item.name)).toEqual(['Old']);
      expect(errorOf(await get('/bed-categories?cursor=made-up', options))).toEqual([
        400,
        'invalid_cursor',
      ]);
    } finally {
      await cleanUp([fresh]);
    }
  });
});

describe('wards', () => {
  it('are added with no rooms, at the session’s hospital, in a department of it', async () => {
    const response = await post('/wards', {
      code: 'MW-1',
      name: '  Male  ward ',
      floor: ' 2nd floor ',
      departmentId: department,
    });
    const detail = await ok<Detail>(response, 201);
    expect(detail).toEqual({
      ward: {
        id: detail.ward.id,
        tenantId: hospital.id,
        code: 'MW-1',
        name: 'Male ward',
        floor: '2nd floor',
        departmentId: department,
        departmentName: 'General Medicine',
        roomCount: 0,
        bedCount: 0,
        archived: false,
        version: 1,
      },
      rooms: [],
    });
    expect(await audited('ward', detail.ward.id)).toEqual(['create']);
    expect(await events(detail.ward.id)).toEqual([{ kind: 'ward', change: 'created' }]);
  });

  it('refuse a code the hospital has, and a department that is not one of it in use', async () => {
    await addWard({ code: 'DUP-W' });
    const again = { code: 'dup-w', name: 'Other' };
    expect(errorOf(await post('/wards', again))).toEqual([409, 'ward_code_taken']);
    const results = await Promise.all([
      post('/wards', { code: 'RACE-W', name: 'Race' }),
      post('/wards', { code: 'RACE-W', name: 'Race' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);

    const archivedDepartment = await departmentOf(hospital, 'Closed Department');
    await pool.query('update departments set archived = true where id = $1', [archivedDepartment]);
    for (const departmentId of [clinicDepartment, archivedDepartment, randomUUID(), 'not-an-id']) {
      expect(
        (await post('/wards', { code: unique('W'), name: 'Ward', departmentId })).statusCode,
        departmentId,
      ).toBe(400);
    }
    const good = { code: 'OK-W', name: 'Fine' };
    for (const body of [
      { ...good, code: 'has space' },
      { ...good, code: 'x'.repeat(21) },
      { ...good, name: ' ' },
      { ...good, name: 'x'.repeat(101) },
      { ...good, floor: 'x'.repeat(51) },
      { name: 'Fine' },
    ]) {
      expect((await post('/wards', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('are changed from the version that was read, never their code', async () => {
    const { ward } = await addWard({ floor: 'Ground', departmentId: department });
    const url = `/wards/${ward.id}`;
    const changed = await patch(url, {
      code: 'NEW',
      name: 'Renamed Ward',
      floor: '',
      departmentId: '',
      expectedVersion: 1,
    });
    const saved = (await ok<Detail>(changed)).ward;
    expect(saved).toMatchObject({ code: ward.code, name: 'Renamed Ward', version: 2 });
    expect(saved).not.toHaveProperty('floor');
    expect(saved).not.toHaveProperty('departmentId');
    expect(saved).not.toHaveProperty('departmentName');
    expect(errorOf(await patch(url, { name: 'Late', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    expect(
      (await ok<Detail>(await patch(url, { name: 'Renamed Ward', expectedVersion: 2 }))).ward
        .version,
    ).toBe(2);
    await expect(
      pool.query("update wards set code = 'FORCED' where id = $1", [ward.id]),
    ).rejects.toThrow(/cannot be changed/);
    const results = await Promise.all([
      patch(url, { name: 'A', expectedVersion: 2 }),
      patch(url, { name: 'B', expectedVersion: 2 }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await audited('ward', ward.id)).toEqual(['create', 'update', 'update']);
  });

  it('are listed by name with their counts, searched by code or name', async () => {
    const fresh = await createTenant(pool, 'Wards List', { features: { wards: true } });
    await grantRoleDefaults(app, fresh);
    await addMembership(pool, admin, fresh, 'admin');
    const options = { tenant: fresh };
    try {
      const category = await addCategory('General', {}, options);
      const names: [string, string][] = [
        ['MED', 'medical ward'],
        ['SUR', 'Surgical ward'],
        ['ICU', 'Intensive care'],
      ];
      const made: Record<string, string> = {};
      for (const [code, name] of names) {
        made[code] = (await ok<Detail>(await post('/wards', { code, name }, options), 201)).ward.id;
      }
      const old = await ok<Detail>(
        await post('/wards', { code: 'OLD', name: 'Old ward' }, options),
        201,
      );
      await post(`/wards/${old.ward.id}/archive`, undefined, options);
      // Two rooms and three beds in one ward, one bed archived and one room archived with its bed.
      const med = made.MED ?? '';
      const [a, b] = [
        (await addRoom(med, 'A', options)).rooms.find((room) => room.name === 'A'),
        (await addRoom(med, 'B', options)).rooms.find((room) => room.name === 'B'),
      ];
      const bed = (roomId: string, number: string) =>
        post(`/wards/${med}/rooms/${roomId}/beds`, { number, bedCategoryId: category.id }, options);
      await bed(a?.id ?? '', '1');
      const second = await ok<Detail>(await bed(a?.id ?? '', '2'), 201);
      await bed(b?.id ?? '', '3');
      const two = second.rooms.flatMap((room) => room.beds).find((each) => each.number === '2');
      await post(`/wards/${med}/beds/${two?.id}/archive`, undefined, options);
      await post(`/wards/${med}/rooms/${b?.id}/archive`, undefined, options);

      const first = await ok<Page<Ward>>(await get('/wards?limit=2', options));
      expect(first.items.map((item) => item.name)).toEqual(['Intensive care', 'medical ward']);
      expect(first.total).toBe(3);
      expect(first.items[1]).toMatchObject({ roomCount: 1, bedCount: 1 });
      const next = await ok<Page<Ward>>(
        await get(`/wards?limit=2&cursor=${first.nextCursor}`, options),
      );
      expect(next.items.map((item) => item.name)).toEqual(['Surgical ward']);
      expect(next.total).toBeUndefined();

      const found = async (q: string) =>
        (await ok<Page<Ward>>(await get(`/wards?q=${encodeURIComponent(q)}`, options))).items.map(
          (item) => item.code,
        );
      expect(await found('ward')).toEqual(['MED', 'SUR']);
      expect(await found('WARD sur')).toEqual(['SUR']);
      expect(await found('icu')).toEqual(['ICU']);
      expect(await found('%')).toEqual([]);
      const archived = await ok<Page<Ward>>(await get('/wards?archived=true', options));
      expect(archived.items.map((item) => item.code)).toEqual(['OLD']);
      expect(errorOf(await get('/wards?cursor=made-up', options))).toEqual([400, 'invalid_cursor']);
      expect((await get('/wards?limit=101', options)).statusCode).toBe(400);
    } finally {
      await cleanUp([fresh]);
    }
  });

  it('are not archived while a bed is occupied, and nothing of an archived ward is changed', async () => {
    const { ward, room, addBed, act } = await wardWithRoom();
    const bed = await addBed('O1');
    const other = await addBed('O2');
    await setStatus(bed.id, 'occupied');
    expect(errorOf(await post(`/wards/${ward.id}/archive`))).toEqual([
      409,
      'ward_has_occupied_beds',
    ]);
    await expect(
      pool.query('update wards set archived = true where id = $1', [ward.id]),
    ).rejects.toThrow(/occupied bed/);
    await setStatus(bed.id, 'cleaning');

    const archived = await ok<Detail>(await post(`/wards/${ward.id}/archive`));
    expect(archived.ward).toMatchObject({ archived: true, version: 2 });
    // Archiving a ward leaves its rooms and beds as they are.
    expect(archived.rooms[0]?.beds.map((each) => [each.archived, each.status])).toEqual([
      [false, 'cleaning'],
      [false, 'available'],
    ]);
    expect((await ok<Detail>(await post(`/wards/${ward.id}/archive`))).ward.version).toBe(2);

    const refused = [409, 'ward_archived'];
    const beds = `/wards/${ward.id}/beds/${other.id}`;
    const rooms = `/wards/${ward.id}/rooms`;
    expect(errorOf(await post(rooms, { name: 'New' }))).toEqual(refused);
    expect(errorOf(await patch(`${rooms}/${room.id}`, { name: 'X', expectedVersion: 1 }))).toEqual(
      refused,
    );
    expect(errorOf(await post(`${rooms}/${room.id}/archive`))).toEqual(refused);
    expect(
      errorOf(await post(`${rooms}/${room.id}/beds`, { number: 'N', bedCategoryId: general })),
    ).toEqual(refused);
    expect(errorOf(await patch(beds, { number: 'X', expectedVersion: 1 }))).toEqual(refused);
    expect(errorOf(await act(other.id, 'block', { reason: 'repair' }))).toEqual(refused);
    expect(errorOf(await act(other.id, 'archive'))).toEqual(refused);
    // It can still be read, renamed and restored.
    expect((await read(ward.id)).ward.archived).toBe(true);
    const restored = await ok<Detail>(await post(`/wards/${ward.id}/restore`));
    expect(restored.ward).toMatchObject({ archived: false, version: 3 });
    expect(await audited('ward', ward.id)).toEqual(['create', 'archive', 'restore']);
    expect((await events(ward.id)).map((payload) => payload.change)).toEqual([
      'created',
      'archived',
      'restored',
    ]);
  });
});

describe('rooms', () => {
  it('are added to a ward, one of a name in it, in the order people count them', async () => {
    const { ward } = await addWard();
    for (const name of ['Room 10', 'room 2', 'Room 1']) await addRoom(ward.id, name);
    const detail = await read(ward.id);
    expect(detail.rooms.map((room) => room.name)).toEqual(['Room 1', 'room 2', 'Room 10']);
    expect(detail.ward).toMatchObject({ roomCount: 3, version: 1 });
    const room = detail.rooms[0];
    expect(await audited('room', room?.id ?? '')).toEqual(['create']);

    expect(errorOf(await post(`/wards/${ward.id}/rooms`, { name: 'ROOM 2' }))).toEqual([
      409,
      'room_name_taken',
    ]);
    // The same name in another ward is another room.
    const other = await addWard();
    expect((await post(`/wards/${other.ward.id}/rooms`, { name: 'Room 1' })).statusCode).toBe(201);
    const results = await Promise.all([
      post(`/wards/${ward.id}/rooms`, { name: 'Room Race' }),
      post(`/wards/${ward.id}/rooms`, { name: 'Room Race' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    for (const body of [{}, { name: ' ' }, { name: 'x'.repeat(51) }]) {
      expect((await post(`/wards/${ward.id}/rooms`, body)).statusCode).toBe(400);
    }
  });

  it('are renamed from the version that was read', async () => {
    const { ward } = await addWard();
    await addRoom(ward.id, 'Left');
    const detail = await addRoom(ward.id, 'Right');
    const left = detail.rooms.find((room) => room.name === 'Left');
    const url = `/wards/${ward.id}/rooms/${left?.id}`;

    const renamed = await ok<Detail>(await patch(url, { name: ' Centre ', expectedVersion: 1 }));
    expect(renamed.rooms.find((room) => room.id === left?.id)).toMatchObject({
      name: 'Centre',
      version: 2,
    });
    expect(errorOf(await patch(url, { name: 'Late', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    expect(errorOf(await patch(url, { name: 'RIGHT', expectedVersion: 2 }))).toEqual([
      409,
      'room_name_taken',
    ]);
    // Its own name in other capitals is a rename; the same name is nothing.
    expect(
      (await ok<Detail>(await patch(url, { name: 'CENTRE', expectedVersion: 2 }))).rooms[0]
        ?.version,
    ).toBe(3);
    expect(
      (await ok<Detail>(await patch(url, { name: 'CENTRE', expectedVersion: 3 }))).rooms[0]
        ?.version,
    ).toBe(3);
    expect((await patch(url, { name: 'No version' })).statusCode).toBe(400);
    expect(await audited('room', left?.id ?? '')).toEqual(['create', 'update', 'update']);
  });

  it('are archived with their beds, each keeping its status, and come back without them', async () => {
    const { ward, room, addBed, bed } = await wardWithRoom();
    const [free, cleaning, blocked, occupied] = [
      await addBed('R1'),
      await addBed('R2'),
      await addBed('R3'),
      await addBed('R4'),
    ];
    await setStatus(cleaning.id, 'cleaning');
    await post(`/wards/${ward.id}/beds/${blocked.id}/block`, {
      reason: 'repair',
      note: 'Broken rail',
    });
    await setStatus(occupied.id, 'occupied');
    const url = `/wards/${ward.id}/rooms/${room.id}`;

    expect(errorOf(await post(`${url}/archive`))).toEqual([409, 'room_has_occupied_beds']);
    await setStatus(occupied.id, 'available');
    const archived = await ok<Detail>(await post(`${url}/archive`));
    expect(archived.rooms[0]).toMatchObject({ archived: true, version: 2 });
    expect(archived.rooms[0]?.beds.map((each) => [each.archived, each.status])).toEqual([
      [true, 'available'],
      [true, 'cleaning'],
      [true, 'blocked'],
      [true, 'available'],
    ]);
    expect(archived.ward).toMatchObject({ roomCount: 0, bedCount: 0 });
    expect(await audited('bed', free.id)).toEqual(['create', 'archive']);
    expect((await ok<Detail>(await post(`${url}/archive`))).rooms[0]?.version).toBe(2);

    // An archived room is not renamed, takes no bed, and its beds do not come back before it.
    expect(errorOf(await patch(url, { name: 'X', expectedVersion: 2 }))).toEqual([
      409,
      'room_archived',
    ]);
    expect(errorOf(await post(`${url}/beds`, { number: 'R5', bedCategoryId: general }))).toEqual([
      409,
      'room_archived',
    ]);
    expect(errorOf(await post(`/wards/${ward.id}/beds/${free.id}/restore`))).toEqual([
      409,
      'room_archived',
    ]);

    const restored = await ok<Detail>(await post(`${url}/restore`));
    expect(restored.rooms[0]).toMatchObject({ archived: false, version: 3 });
    expect(restored.rooms[0]?.beds.every((each) => each.archived)).toBe(true);
    expect(restored.ward).toMatchObject({ roomCount: 1, bedCount: 0 });
    // Each bed comes back on its own, in the status it had.
    await post(`/wards/${ward.id}/beds/${blocked.id}/restore`);
    expect(await bed(blocked.id)).toMatchObject({
      archived: false,
      status: 'blocked',
      blockedReason: 'repair',
      blockedNote: 'Broken rail',
    });
    expect(await audited('room', room.id)).toEqual(['create', 'archive', 'restore']);
  });
});

describe('beds', () => {
  it('are added to a room, available, one of a number in the ward, in the order people count them', async () => {
    const { ward, room, addBed } = await wardWithRoom();
    for (const number of ['Bed 10', 'bed 2', 'Bed 1']) await addBed(number);
    const detail = await read(ward.id);
    const beds = detail.rooms[0]?.beds ?? [];
    expect(beds.map((each) => each.number)).toEqual(['Bed 1', 'bed 2', 'Bed 10']);
    expect(beds[0]).toEqual({
      id: beds[0]?.id,
      roomId: room.id,
      number: 'Bed 1',
      bedCategoryId: general,
      bedCategoryName: 'General ward',
      status: 'available',
      archived: false,
      version: 1,
    });
    expect(detail.ward).toMatchObject({ roomCount: 1, bedCount: 3 });
    expect(await audited('bed', beds[0]?.id ?? '')).toEqual(['create']);

    // A number is one in its ward, whichever room it is in.
    const second = (await addRoom(ward.id, 'Room 2')).rooms.find((each) => each.name === 'Room 2');
    const body = { number: 'BED 2', bedCategoryId: general };
    expect(errorOf(await post(`/wards/${ward.id}/rooms/${second?.id}/beds`, body))).toEqual([
      409,
      'bed_number_taken',
    ]);
    const url = `/wards/${ward.id}/rooms/${room.id}/beds`;
    const results = await Promise.all([
      post(url, { number: 'Race', bedCategoryId: general }),
      post(url, { number: 'Race', bedCategoryId: general }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    for (const bad of [
      { number: 'N1' },
      { number: ' ', bedCategoryId: general },
      { number: 'x'.repeat(21), bedCategoryId: general },
      { number: 'N1', bedCategoryId: clinicGeneral },
      { number: 'N1', bedCategoryId: randomUUID() },
      { number: 'N1', bedCategoryId: 'not-an-id' },
    ]) {
      expect((await post(url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // A status sent with a new bed is dropped: a bed starts available.
    const sent = await ok<Detail>(
      await post(url, { number: 'N2', bedCategoryId: general, status: 'occupied' }),
      201,
    );
    expect(sent.rooms[0]?.beds.find((each) => each.number === 'N2')?.status).toBe('available');
  });

  it('have their number and category changed, never their status', async () => {
    const other = await addCategory();
    const { ward, addBed, bed } = await wardWithRoom();
    const first = await addBed('P1');
    await addBed('P2');
    const url = `/wards/${ward.id}/beds/${first.id}`;

    await ok<Detail>(
      await patch(url, {
        number: ' P1a ',
        bedCategoryId: other.id,
        status: 'occupied',
        expectedVersion: 1,
      }),
    );
    expect(await bed(first.id)).toMatchObject({
      number: 'P1a',
      bedCategoryId: other.id,
      bedCategoryName: other.name,
      status: 'available',
      version: 2,
    });
    expect(errorOf(await patch(url, { number: 'Late', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
    expect(errorOf(await patch(url, { number: 'p2', expectedVersion: 2 }))).toEqual([
      409,
      'bed_number_taken',
    ]);
    await patch(url, { number: 'P1a', expectedVersion: 2 });
    expect((await bed(first.id)).version).toBe(2);

    // The category it has may have been archived since; a new one has to be in use.
    await pool.query('update bed_categories set archived = true where id = $1', [other.id]);
    await ok<Detail>(
      await patch(url, { number: 'P1b', bedCategoryId: other.id, expectedVersion: 2 }),
    );
    const archivedCategory = await addCategory();
    await post(`/bed-categories/${archivedCategory.id}/archive`);
    for (const bedCategoryId of [archivedCategory.id, clinicGeneral, randomUUID()]) {
      expect(
        (await patch(url, { bedCategoryId, expectedVersion: 3 })).statusCode,
        bedCategoryId,
      ).toBe(400);
    }
    expect(await audited('bed', first.id)).toEqual(['create', 'update', 'update']);
  });

  it('are blocked with a reason and put back in use, on the bed as it is', async () => {
    const { addBed, bed, act } = await wardWithRoom();
    const one = await addBed('B1');

    const blocked = await act(one.id, 'block', {
      reason: 'deep_cleaning',
      note: '  After  a spill ',
    });
    expect(blocked.statusCode).toBe(200);
    expect(await bed(one.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'deep_cleaning',
      blockedNote: 'After a spill',
      version: 2,
    });
    expect(errorOf(await act(one.id, 'block', { reason: 'repair' }))).toEqual([
      409,
      'bed_not_available',
    ]);

    expect((await act(one.id, 'unblock')).statusCode).toBe(200);
    const free = await bed(one.id);
    expect(free).toMatchObject({ status: 'available', version: 3 });
    expect(free).not.toHaveProperty('blockedReason');
    expect(free).not.toHaveProperty('blockedNote');
    expect(errorOf(await act(one.id, 'unblock'))).toEqual([409, 'bed_not_blocked']);

    for (const body of [
      undefined,
      {},
      { reason: 'holiday' },
      { reason: 'repair', note: 'x'.repeat(101) },
    ]) {
      expect((await act(one.id, 'block', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // Only an available bed is blocked: not one a patient is in, or one being cleaned.
    for (const status of ['occupied', 'cleaning']) {
      await setStatus(one.id, status);
      expect(errorOf(await act(one.id, 'block', { reason: 'repair' })), status).toEqual([
        409,
        'bed_not_available',
      ]);
      expect(errorOf(await act(one.id, 'unblock')), status).toEqual([409, 'bed_not_blocked']);
    }
    expect(await audited('bed', one.id)).toEqual(['create', 'block', 'unblock']);
  });

  it('never put the note of a block in an audit entry or an event', async () => {
    const { addBed, act } = await wardWithRoom();
    const one = await addBed('B2');
    await act(one.id, 'block', { reason: 'other', note: 'Secret words' });
    expect((await events(one.id)).at(-1)).toEqual({
      kind: 'bed',
      change: 'blocked',
      reason: 'other',
    });
    const { rows } = await pool.query(
      `select 1 from audit_log where tenant_id = $1 and to_jsonb(audit_log)::text like '%Secret words%'
       union all
       select 1 from outbox where tenant_id = $1 and payload::text like '%Secret words%'`,
      [hospital.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('let one of two people block the same bed at the same moment', async () => {
    const { addBed, act } = await wardWithRoom();
    const one = await addBed('B3');
    const results = await Promise.all([
      act(one.id, 'block', { reason: 'repair' }),
      act(one.id, 'block', { reason: 'reserved' }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('are archived unless a patient is in them, keeping their status, and restored', async () => {
    const { addBed, bed, act } = await wardWithRoom();
    const one = await addBed('A1');
    await setStatus(one.id, 'occupied');
    expect(errorOf(await act(one.id, 'archive'))).toEqual([409, 'bed_occupied']);
    await setStatus(one.id, 'cleaning');

    expect((await act(one.id, 'archive')).statusCode).toBe(200);
    expect(await bed(one.id)).toMatchObject({ archived: true, status: 'cleaning' });
    const version = (await bed(one.id)).version;
    expect((await act(one.id, 'archive')).statusCode).toBe(200);
    expect((await bed(one.id)).version).toBe(version);
    // Nothing happens to an archived bed: it is restored first.
    expect(errorOf(await act(one.id, 'block', { reason: 'repair' }))).toEqual([
      409,
      'bed_not_available',
    ]);
    expect(errorOf(await act(one.id, 'unblock'))).toEqual([409, 'bed_not_blocked']);
    expect(
      errorOf(
        await patch(`/wards/${(await wardOf(one.id)).id}/beds/${one.id}`, {
          number: 'X',
          expectedVersion: version,
        }),
      ),
    ).toEqual([409, 'bed_archived']);

    expect((await act(one.id, 'restore')).statusCode).toBe(200);
    // Still being cleaned: archiving was no way round housekeeping.
    expect(await bed(one.id)).toMatchObject({ archived: false, status: 'cleaning' });
    expect((await act(one.id, 'restore')).statusCode).toBe(200);
    expect(await audited('bed', one.id)).toEqual(['create', 'archive', 'restore']);
  });
});

/** The ward a bed is in, from the database. */
async function wardOf(bedId: string): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    'select ward_id as id from beds where id = $1',
    [bedId],
  );
  if (!rows[0]) throw new Error('bed not found');
  return rows[0];
}

describe('access', () => {
  it('lets someone who may only read see wards and categories and change nothing', async () => {
    const { ward, room, addBed } = await wardWithRoom();
    const bed = await addBed('Read 1');
    const options = { user: nurse };
    expect((await get('/wards', options)).statusCode).toBe(200);
    expect((await get(`/wards/${ward.id}`, options)).statusCode).toBe(200);
    expect((await get('/bed-categories', options)).statusCode).toBe(200);

    const denied = [403, 'permission_denied'];
    const bedUrl = `/wards/${ward.id}/beds/${bed.id}`;
    const roomUrl = `/wards/${ward.id}/rooms/${room.id}`;
    const refused: Response[] = [
      await post('/bed-categories', { name: 'No' }, options),
      await patch(`/bed-categories/${general}`, { name: 'No', expectedVersion: 1 }, options),
      await post(`/bed-categories/${general}/archive`, undefined, options),
      await post('/wards', { code: 'NO', name: 'No' }, options),
      await patch(`/wards/${ward.id}`, { name: 'No', expectedVersion: 1 }, options),
      await post(`/wards/${ward.id}/archive`, undefined, options),
      await post(`/wards/${ward.id}/rooms`, { name: 'No' }, options),
      await patch(roomUrl, { name: 'No', expectedVersion: 1 }, options),
      await post(`${roomUrl}/archive`, undefined, options),
      await post(`${roomUrl}/beds`, { number: 'No', bedCategoryId: general }, options),
      await patch(bedUrl, { number: 'No', expectedVersion: 1 }, options),
      await post(`${bedUrl}/block`, { reason: 'repair' }, options),
      await post(`${bedUrl}/unblock`, undefined, options),
      await post(`${bedUrl}/archive`, undefined, options),
      await post(`${bedUrl}/restore`, undefined, options),
    ];
    for (const response of refused) expect(errorOf(response)).toEqual(denied);
  });

  it('shows nothing to a role without the permission', async () => {
    const options = { user: pharmacist };
    expect(errorOf(await get('/wards', options))).toEqual([403, 'permission_denied']);
    expect(errorOf(await get('/bed-categories', options))).toEqual([403, 'permission_denied']);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };
    expect(errorOf(await get('/wards', options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await post('/bed-categories', { name: 'X' }, options))).toEqual([
      403,
      'feature_disabled',
    ]);
  });

  it('needs a session', async () => {
    expect((await app.inject({ url: '/wards' })).statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('keeps each hospital’s wards and categories to itself, and lets both use a code and a name', async () => {
    const ours = await addWard({ code: 'BOTH' });
    const theirs = await addWard({ code: 'BOTH' }, { tenant: clinic });
    expect(theirs.ward.tenantId).toBe(clinic.id);
    const seen = await ok<Page<Ward>>(await get('/wards?q=BOTH', { tenant: clinic }));
    expect(seen.items.map((item) => item.id)).toEqual([theirs.ward.id]);
    const mine = await ok<Page<Ward>>(await get('/wards?q=BOTH'));
    expect(mine.items.map((item) => item.id)).toEqual([ours.ward.id]);
    const categories = await ok<Page<Category>>(
      await get('/bed-categories?limit=100', { tenant: clinic }),
    );
    expect(categories.items.every((item) => item.tenantId === clinic.id)).toBe(true);
  });

  it('has one answer for what is another hospital’s, another ward’s, and what does not exist', async () => {
    const mine = await wardWithRoom();
    const myBed = await mine.addBed('Mine 1');
    const theirs = await wardWithRoom({ tenant: clinic });
    const theirBed = await theirs.addBed('Theirs 1');
    const elsewhere = await wardWithRoom();
    const otherBed = await elsewhere.addBed('Elsewhere 1');

    for (const wardId of [theirs.ward.id, randomUUID(), 'not-an-id']) {
      const missing = [404, 'ward_not_found'];
      expect(errorOf(await get(`/wards/${wardId}`)), wardId).toEqual(missing);
      expect(errorOf(await patch(`/wards/${wardId}`, { name: 'X', expectedVersion: 1 }))).toEqual(
        missing,
      );
      expect(errorOf(await post(`/wards/${wardId}/archive`))).toEqual(missing);
      expect(errorOf(await post(`/wards/${wardId}/rooms`, { name: 'X' }))).toEqual(missing);
      expect(
        errorOf(await post(`/wards/${wardId}/beds/${myBed.id}/block`, { reason: 'repair' })),
      ).toEqual(missing);
    }
    // A room or a bed is looked up inside the ward named.
    for (const roomId of [theirs.room.id, elsewhere.room.id, randomUUID(), 'not-an-id']) {
      const url = `/wards/${mine.ward.id}/rooms/${roomId}`;
      expect(errorOf(await patch(url, { name: 'X', expectedVersion: 1 })), roomId).toEqual([
        404,
        'room_not_found',
      ]);
      expect(errorOf(await post(`${url}/archive`))).toEqual([404, 'room_not_found']);
      expect(errorOf(await post(`${url}/beds`, { number: 'X', bedCategoryId: general }))).toEqual([
        404,
        'room_not_found',
      ]);
    }
    for (const bedId of [theirBed.id, otherBed.id, randomUUID(), 'not-an-id']) {
      const url = `/wards/${mine.ward.id}/beds/${bedId}`;
      const missing = [404, 'bed_not_found'];
      expect(errorOf(await patch(url, { number: 'X', expectedVersion: 1 })), bedId).toEqual(
        missing,
      );
      for (const action of ['unblock', 'archive', 'restore']) {
        expect(errorOf(await post(`${url}/${action}`)), action).toEqual(missing);
      }
      expect(errorOf(await post(`${url}/block`, { reason: 'repair' }))).toEqual(missing);
    }
    for (const id of [clinicGeneral, randomUUID(), 'not-an-id']) {
      const missing = [404, 'bed_category_not_found'];
      expect(
        errorOf(await patch(`/bed-categories/${id}`, { name: 'X', expectedVersion: 1 })),
        id,
      ).toEqual(missing);
      expect(errorOf(await post(`/bed-categories/${id}/archive`))).toEqual(missing);
    }
    expect((await theirs.bed(theirBed.id)).version).toBe(1);
    expect((await elsewhere.bed(otherBed.id)).version).toBe(1);
  });

  it('is kept apart, and held to its rules, by the database itself', async () => {
    const mine = await wardWithRoom();
    const myBed = await mine.addBed('DB 1');
    const second = await wardWithRoom();
    const theirs = await wardWithRoom({ tenant: clinic });
    const theirBed = await theirs.addBed('DB T1');

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      ward: (await client.query('select 1 from wards where id = $1', [theirs.ward.id])).rowCount,
      bed: (await client.query('select 1 from beds where id = $1', [theirBed.id])).rowCount,
      updated: (
        await client.query("update beds set number = 'Stolen' where id = $1", [theirBed.id])
      ).rowCount,
      tenants: (
        await client.query<{ tenant_id: string }>(
          `select distinct tenant_id from wards union select distinct tenant_id from rooms
           union select distinct tenant_id from beds union select distinct tenant_id from bed_categories`,
        )
      ).rows,
    }));
    expect(seen).toEqual({ ward: 0, bed: 0, updated: 0, tenants: [{ tenant_id: hospital.id }] });

    const sql = (text: string, params: unknown[] = []) =>
      asTenantSql(pool, hospital.id, (client) => client.query(text, params));
    const bed = `insert into beds (tenant_id, ward_id, room_id, number, bed_category_id)
      values ($1, $2, $3, $4, $5)`;
    // Nor can a hospital put a ward into another, or delete anything of its own.
    await expect(
      sql("insert into wards (tenant_id, code, name) values ($1, 'PLANTED', 'Planted')", [
        clinic.id,
      ]),
    ).rejects.toThrow(/row-level security/);
    for (const table of ['beds', 'rooms', 'wards', 'bed_categories']) {
      await expect(sql(`delete from ${table}`), table).rejects.toThrow(/permission denied/);
    }
    // A bed is in a room of its own ward, with a category of its own hospital.
    await expect(
      sql(bed, [hospital.id, mine.ward.id, second.room.id, 'X1', general]),
    ).rejects.toThrow(/beds_room/);
    await expect(
      sql(bed, [hospital.id, mine.ward.id, theirs.room.id, 'X2', general]),
    ).rejects.toThrow(/beds_room/);
    await expect(
      sql(bed, [hospital.id, mine.ward.id, mine.room.id, 'X3', clinicGeneral]),
    ).rejects.toThrow(/beds_category/);
    await expect(
      sql(bed, [hospital.id, mine.ward.id, mine.room.id, 'db 1', general]),
    ).rejects.toThrow(/beds_number_taken/);
    // A category is charged as a service of its own hospital, a ward in a department of it.
    await expect(
      sql('update bed_categories set service_id = $2 where id = $1', [general, clinicBedService]),
    ).rejects.toThrow(/bed_categories_service/);
    await expect(
      sql('update wards set department_id = $2 where id = $1', [mine.ward.id, clinicDepartment]),
    ).rejects.toThrow(/wards_department/);
    // A blocked bed has a reason, only a blocked bed has one, and an occupied bed is not archived.
    const set = (changes: string) => sql(`update beds set ${changes} where id = $1`, [myBed.id]);
    await expect(set("status = 'blocked'")).rejects.toThrow(/beds_blocked_has_a_reason/);
    await expect(set("blocked_reason = 'repair'")).rejects.toThrow(/beds_blocked_has_a_reason/);
    await expect(set("blocked_note = 'A note'")).rejects.toThrow(/beds_note_of_a_block/);
    await expect(set("status = 'occupied', archived = true")).rejects.toThrow(
      /beds_occupied_not_archived|archived bed/,
    );
    // The status of an archived bed does not change, and a bed does not move.
    await pool.query('update beds set archived = true where id = $1', [myBed.id]);
    await expect(set("status = 'cleaning'")).rejects.toThrow(/archived bed/);
    await expect(
      sql('update beds set ward_id = $2 where id = $1', [myBed.id, second.ward.id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      sql('update rooms set ward_id = $2 where id = $1', [mine.room.id, second.ward.id]),
    ).rejects.toThrow(/cannot be changed/);
    // The version of each is the database's to count.
    const { rows } = await pool.query<{ version: number }>(
      "update rooms set name = 'Counted', version = 99 where id = $1 returning version",
      [second.room.id],
    );
    expect(rows[0]?.version).toBe(2);
  });
});

describe('found in review', () => {
  it('answers a repeat of adding a room or a bed with the ward as it is, and adds nothing', async () => {
    const { ward, room, addBed, act } = await wardWithRoom();
    const blocked = await addBed('RP-0');
    await act(blocked.id, 'block', { reason: 'other', note: 'Replay secret' });

    const roomKey = `wards-${randomUUID()}`;
    const first = await post(`/wards/${ward.id}/rooms`, { name: 'Once' }, { key: roomKey });
    // Something else changes before the answer is asked for again.
    await addBed('RP-1');
    const second = await post(`/wards/${ward.id}/rooms`, { name: 'Once' }, { key: roomKey });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const again = second.json<Detail>();
    expect(again.rooms.map((each) => each.name)).toEqual(['Once', 'Room 1']);
    expect(again.rooms[1]?.beds.map((each) => each.number)).toEqual(['RP-0', 'RP-1']);

    const bedKey = `wards-${randomUUID()}`;
    const body = { number: 'RP-2', bedCategoryId: general };
    const url = `/wards/${ward.id}/rooms/${room.id}/beds`;
    expect((await post(url, body, { key: bedKey })).statusCode).toBe(201);
    const replayed = await post(url, body, { key: bedKey });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json<Detail>().ward.bedCount).toBe(3);
    // Without the key, or with it for another request, it is a new request.
    expect(errorOf(await post(url, body))).toEqual([409, 'bed_number_taken']);
    expect(errorOf(await post(url, { ...body, number: 'RP-3' }, { key: bedKey }))).toEqual([
      422,
      'idempotency_key_reuse',
    ]);

    // Nothing of the answers was kept: not the note, not the ward.
    const { rows } = await pool.query<{ status: number; body: unknown }>(
      `select response_status as status, response_body as body from idempotency_keys
       where tenant_id = $1 and key = any($2::text[])`,
      [hospital.id, [roomKey, bedKey]],
    );
    expect(rows).toEqual([
      { status: 201, body: null },
      { status: 201, body: null },
    ]);
    // And the work was audited once.
    const made = again.rooms.find((each) => each.name === 'Once');
    expect(await audited('room', made?.id ?? '')).toEqual(['create']);
  });

  it('answers a repeat of adding a ward with the same ward', async () => {
    const key = `wards-${randomUUID()}`;
    const body = { code: unique('W'), name: 'Ward Once' };
    const first = await post('/wards', body, { key });
    const second = await post('/wards', body, { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('says which fields changed, and tells of each bed that goes with its room', async () => {
    const category = await addCategory();
    const { ward, room, addBed } = await wardWithRoom();
    const bed = await addBed('EV-1');
    const last = async (id: string) => (await events(id)).at(-1);

    await patch(`/bed-categories/${category.id}`, { name: unique('Renamed'), expectedVersion: 1 });
    expect(await last(category.id)).toEqual({
      kind: 'bed_category',
      change: 'updated',
      fields: ['name'],
    });
    await patch(`/wards/${ward.id}`, {
      floor: 'Third',
      departmentId: department,
      expectedVersion: 1,
    });
    expect(await last(ward.id)).toEqual({
      kind: 'ward',
      change: 'updated',
      fields: ['floor', 'departmentId'],
    });
    await patch(`/wards/${ward.id}/rooms/${room.id}`, { name: 'Renamed Room', expectedVersion: 1 });
    expect(await last(room.id)).toEqual({ kind: 'room', change: 'updated', fields: ['name'] });
    await patch(`/wards/${ward.id}/beds/${bed.id}`, {
      number: 'EV-1a',
      bedCategoryId: category.id,
      expectedVersion: 1,
    });
    expect(await last(bed.id)).toEqual({
      kind: 'bed',
      change: 'updated',
      fields: ['number', 'bedCategoryId'],
    });

    await post(`/wards/${ward.id}/rooms/${room.id}/archive`);
    expect(await last(bed.id)).toEqual({ kind: 'bed', change: 'archived' });
    expect(await last(room.id)).toEqual({ kind: 'room', change: 'archived' });
  });

  it('lets a room, a bed and a category change the capitals of its own name', async () => {
    const category = await addCategory('recased category');
    const { ward, room, addBed, bed } = await wardWithRoom();
    const one = await addBed('recased');

    const renamed = await patch(`/bed-categories/${category.id}`, {
      name: 'Recased Category',
      expectedVersion: 1,
    });
    expect(renamed.json()).toMatchObject({ name: 'Recased Category', version: 2 });
    const detail = await ok<Detail>(
      await patch(`/wards/${ward.id}/rooms/${room.id}`, { name: 'ROOM 1', expectedVersion: 1 }),
    );
    expect(detail.rooms[0]).toMatchObject({ name: 'ROOM 1', version: 2 });
    await patch(`/wards/${ward.id}/beds/${one.id}`, { number: 'RECASED', expectedVersion: 1 });
    expect(await bed(one.id)).toMatchObject({ number: 'RECASED', version: 2 });
  });

  it('never gives a bed a category that was archived at the same moment', async () => {
    for (let round = 0; round < 3; round++) {
      const category = await addCategory();
      const { ward, room } = await wardWithRoom();
      const [added, archived] = await Promise.all([
        post(`/wards/${ward.id}/rooms/${room.id}/beds`, {
          number: 'CR-1',
          bedCategoryId: category.id,
        }),
        post(`/bed-categories/${category.id}/archive`),
      ]);
      // Either the bed has it and it stays in use, or it was archived and the bed was refused.
      expect([
        [201, 409],
        [400, 200],
      ]).toContainEqual([added.statusCode, archived.statusCode]);
    }
  });

  it('never brings a bed back with a category that was archived at the same moment', async () => {
    const category = await addCategory();
    const { addBed, bed, act } = await wardWithRoom();
    const one = await addBed('CR-2', category.id);
    await act(one.id, 'archive');
    const [restored, archived] = await Promise.all([
      act(one.id, 'restore'),
      post(`/bed-categories/${category.id}/archive`),
    ]);
    expect([
      [200, 409],
      [409, 200],
    ]).toContainEqual([restored.statusCode, archived.statusCode]);
    expect((await bed(one.id)).archived).toBe(restored.statusCode !== 200);
  });

  it('gives a ward no more rooms and beds than a ward can have', async () => {
    const { ward, room } = await wardWithRoom();
    // Up to the limits, as bulk work would leave it: archived ones count.
    await pool.query(
      `insert into rooms (tenant_id, ward_id, name, archived)
       select $1, $2, 'Filler ' || n, true from generate_series(1, 199) as n`,
      [hospital.id, ward.id],
    );
    await pool.query(
      `insert into beds (tenant_id, ward_id, room_id, number, bed_category_id, archived)
       select $1, $2, $3, 'F-' || n, $4, n > 500 from generate_series(1, 999) as n`,
      [hospital.id, ward.id, room.id, general],
    );
    expect(errorOf(await post(`/wards/${ward.id}/rooms`, { name: 'One too many' }))).toEqual([
      409,
      'ward_room_limit',
    ]);
    const beds = `/wards/${ward.id}/rooms/${room.id}/beds`;
    expect((await post(beds, { number: 'Last', bedCategoryId: general })).statusCode).toBe(201);
    expect(errorOf(await post(beds, { number: 'Over', bedCategoryId: general }))).toEqual([
      409,
      'ward_bed_limit',
    ]);
    // A full ward is still read, in the order people count, with every bed in its room.
    const detail = await read(ward.id);
    expect(detail.rooms).toHaveLength(200);
    expect(detail.rooms.find((each) => each.id === room.id)?.beds).toHaveLength(1000);
    expect(detail.ward).toMatchObject({ roomCount: 1, bedCount: 501 });
  });

  it('needs the right to read wards as well as to change them', async () => {
    // A role a hospital made for itself: it may manage wards, and may not read them.
    await pool.query(
      "insert into roles (tenant_id, id, name, built_in) values ($1, 'ward_fixer', 'Ward fixer', false)",
      [hospital.id],
    );
    await pool.query(
      "insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, 'ward_fixer', 'ward:manage', 'all')",
      [hospital.id],
    );
    const fixer = await createUser(pool, 'Wards Fixer', { withPassword: false });
    await addMembership(pool, fixer, hospital, 'ward_fixer');
    try {
      const { ward } = await addWard();
      const options = { user: fixer };
      const denied = [403, 'permission_denied'];
      // Restoring a ward that is in use changes nothing, and used to answer with all of it.
      expect(errorOf(await post(`/wards/${ward.id}/restore`, undefined, options))).toEqual(denied);
      expect(errorOf(await post(`/wards/${ward.id}/rooms`, { name: 'X' }, options))).toEqual(
        denied,
      );
      expect(errorOf(await get(`/wards/${ward.id}`, options))).toEqual(denied);
    } finally {
      await deleteUsers(pool, [fixer]);
    }
  });

  it('holds what a patient is in, whichever of two changes comes first', async () => {
    const { ward, addBed } = await wardWithRoom();
    const bed = await addBed('RC-1');
    // As admissions will: a patient is given the bed in a transaction that is still open.
    const admission = await pool.connect();
    try {
      await admission.query('begin');
      await admission.query("update beds set status = 'occupied' where id = $1", [bed.id]);
      const archiving = post(`/wards/${ward.id}/archive`);
      // The archive waits for the bed. It is answered only once the admission ends.
      const early = await Promise.race([
        archiving.then(() => 'answered'),
        new Promise((done) => setTimeout(() => done('waiting'), 300)),
      ]);
      expect(early).toBe('waiting');
      await admission.query('commit');
      expect(errorOf(await archiving)).toEqual([409, 'ward_has_occupied_beds']);
    } finally {
      admission.release();
    }
    expect((await read(ward.id)).ward.archived).toBe(false);
  });

  it('refuses in the database what the routes refuse', async () => {
    const { ward, room, addBed } = await wardWithRoom();
    const bed = await addBed('DB-R1');
    const other = await addBed('DB-R2');
    // A room is archived with its beds, and a bed does not come back into an archived room.
    await expect(
      pool.query('update rooms set archived = true where id = $1', [room.id]),
    ).rejects.toThrow(/with its beds/);
    await post(`/wards/${ward.id}/rooms/${room.id}/archive`);
    await expect(
      pool.query('update beds set archived = false where id = $1', [bed.id]),
    ).rejects.toThrow(/archived room/);
    // A patient is not put in a bed of an archived room, or of an archived ward.
    await post(`/wards/${ward.id}/rooms/${room.id}/restore`);
    await post(`/wards/${ward.id}/beds/${other.id}/restore`);
    await post(`/wards/${ward.id}/archive`);
    await expect(
      pool.query("update beds set status = 'occupied' where id = $1", [other.id]),
    ).rejects.toThrow(/takes no patient/);
    // Another table can refer to a room and to a bed together with its hospital.
    const { rows } = await pool.query<{ name: string }>(
      `select conname as name from pg_constraint
       where conname in ('rooms_tenant_id_id', 'beds_tenant_id_id') order by 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(['beds_tenant_id_id', 'rooms_tenant_id_id']);
  });
});
