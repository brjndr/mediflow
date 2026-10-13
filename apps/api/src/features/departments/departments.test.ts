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
 * The departments API through the real app and database: the list and its paging, adding,
 * changing with a version, archiving, the hospital boundary, permissions and audit.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
/** A hospital with the departments module switched off. */
let closed: TestTenant;
let admin: TestUser;
/** Sees departments, cannot change them. */
let doctor: TestUser;
/** No department permissions at all. */
let storeKeeper: TestUser;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
interface Department {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  archived: boolean;
  version: number;
}
interface Page {
  items: Department[];
  nextCursor: string | null;
  total?: number;
}

const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const list = (query = '', options: Options = {}) =>
  app.inject({ url: `/departments${query}`, headers: headers(options) });
const add = (body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url: '/departments',
    headers: { ...headers(options), ...(options.key ? { 'idempotency-key': options.key } : {}) },
    payload: body,
  });
const change = (id: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'PATCH',
    url: `/departments/${id}`,
    headers: headers(options),
    payload: body,
  });
const act = (id: string, action: 'archive' | 'restore', options: Options = {}) =>
  app.inject({ method: 'POST', url: `/departments/${id}/${action}`, headers: headers(options) });
const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [
  response.statusCode,
  response.json().error.code,
];
const names = (response: { json: () => Page }) => response.json().items.map((item) => item.name);

/** Adds a department and returns it. */
async function added(name: string, options: Options = {}, description?: string) {
  const response = await add({ name, ...(description ? { description } : {}) }, options);
  if (response.statusCode !== 201) throw new Error(`could not add ${name} in test setup`);
  return response.json<Department>();
}

const audited = async (tenant: TestTenant, entityId: string) => {
  const { rows } = await pool.query<{ action: string; actor_id: string }>(
    `select action, actor_id from audit_log
     where tenant_id = $1 and entity = 'department' and entity_id = $2 order by at`,
    [tenant.id, entityId],
  );
  return rows.map((row) => row.action);
};

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Departments Hospital', { features: { departments: true } });
  clinic = await createTenant(pool, 'Departments Clinic', { features: { departments: true } });
  closed = await createTenant(pool, 'Departments Closed', { features: { departments: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Departments Admin', { withPassword: false });
  doctor = await createUser(pool, 'Departments Doctor', { withPassword: false });
  storeKeeper = await createUser(pool, 'Departments Storekeeper', { withPassword: false });
  for (const tenant of [hospital, clinic, closed])
    await addMembership(pool, admin, tenant, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, storeKeeper, hospital, 'store_keeper');
});

afterAll(async () => {
  await pool.query('delete from departments where tenant_id = any($1)', [
    [hospital.id, clinic.id, closed.id],
  ]);
  await deleteUsers(pool, [admin, doctor, storeKeeper]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await app.close();
});

describe('adding a department', () => {
  it('adds it to the session’s hospital, trimmed, and records who did', async () => {
    const response = await add({ name: '  Cardiology ', description: ' Second floor ' });

    expect(response.statusCode).toBe(201);
    const department = response.json<Department>();
    expect(department).toEqual({
      id: expect.any(String),
      tenantId: hospital.id,
      name: 'Cardiology',
      description: 'Second floor',
      archived: false,
      version: 1,
    });
    expect(await audited(hospital, department.id)).toEqual(['create']);
  });

  it('refuses a name the hospital already has, whatever its capitals, archived or not', async () => {
    const old = await added('Homeopathy');
    await act(old.id, 'archive');

    expect(errorOf(await add({ name: 'cardiology' }))).toEqual([409, 'department_name_taken']);
    expect(errorOf(await add({ name: 'HOMEOPATHY' }))).toEqual([409, 'department_name_taken']);
  });

  it('lets one of two simultaneous requests for a new name through', async () => {
    const results = await Promise.all([add({ name: 'Neurology' }), add({ name: 'neurology' })]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const { rows } = await pool.query(
      "select 1 from departments where tenant_id = $1 and name_lower = 'neurology'",
      [hospital.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('answers a repeat of the same request with the same department, and adds one', async () => {
    const key = `key-${randomUUID()}`;
    const first = await add({ name: 'Oncology' }, { key });
    const again = await add({ name: 'Oncology' }, { key });

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<Department>().id).toBe(first.json<Department>().id);
    // The same key for something else is refused.
    expect(errorOf(await add({ name: 'Urology' }, { key }))).toEqual([
      422,
      'idempotency_key_reuse',
    ]);
  });

  it('keeps nothing of a request that was refused, so the same key can be used again', async () => {
    const key = `key-${randomUUID()}`;
    const blocker = await added('Blocked Name');

    expect(errorOf(await add({ name: 'blocked name' }, { key }))).toEqual([
      409,
      'department_name_taken',
    ]);
    // The other department is renamed, and the very same request now goes through.
    await change(blocker.id, { name: 'Unblocked', expectedVersion: 1 });
    const retried = await add({ name: 'blocked name' }, { key });

    expect(retried.statusCode).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
  });

  it('refuses text the database cannot store, instead of failing', async () => {
    const nul = String.fromCharCode(0);
    expect((await add({ name: `Bad${nul}Name` })).statusCode).toBe(400);
    expect((await add({ name: 'Fine Name', description: `Bad${nul}` })).statusCode).toBe(400);

    const forged = Buffer.from(JSON.stringify({ n: `a${nul}`, i: randomUUID() })).toString(
      'base64url',
    );
    expect(errorOf(await list(`?cursor=${forged}`))).toEqual([400, 'invalid_cursor']);
  });

  it('needs a name, of a sensible length, and takes nothing else', async () => {
    expect((await add({})).statusCode).toBe(400);
    expect((await add({ name: '   ' })).statusCode).toBe(400);
    expect((await add({ name: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await add({ name: 'Fine', description: 'x'.repeat(501) })).statusCode).toBe(400);

    // A tenant in the body is not a way into another hospital.
    const response = await add({ name: 'Dermatology', tenantId: clinic.id });
    expect([400, 201]).toContain(response.statusCode);
    const { rows } = await pool.query(
      "select tenant_id from departments where name_lower = 'dermatology'",
    );
    expect(rows.every((row: { tenant_id: string }) => row.tenant_id === hospital.id)).toBe(true);
  });
});

describe('the list', () => {
  it('is in name order whatever the capitals, a page at a time, with the total once', async () => {
    for (const name of ['anaesthesia', 'Zoology', 'Burns', 'endocrinology']) await added(name);

    const first = await list('?limit=3');
    expect(first.statusCode).toBe(200);
    const page = first.json<Page>();
    expect(page.items).toHaveLength(3);
    expect(page.total).toBeGreaterThanOrEqual(7);
    expect(page.nextCursor).toEqual(expect.any(String));

    const all: string[] = [...names(first)];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await list(`?limit=3&cursor=${encodeURIComponent(cursor)}`);
      expect(next.json<Page>().total).toBeUndefined();
      all.push(...names(next));
      cursor = next.json<Page>().nextCursor;
    }
    expect(all).toEqual([...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('anaesthesia');
    expect(all).not.toContain('Homeopathy');
  });

  it('shows the archived departments only when asked', async () => {
    const archived = await list('?archived=true');

    expect(names(archived)).toEqual(['Homeopathy']);
    expect(archived.json<Page>().total).toBe(1);
  });

  it('refuses a cursor it did not make', async () => {
    expect(errorOf(await list('?cursor=not-a-cursor'))).toEqual([400, 'invalid_cursor']);
  });
});

describe('changing a department', () => {
  it('saves a new name and description from the version that was read', async () => {
    const department = await added('Physio');

    const response = await change(department.id, {
      name: 'Physiotherapy',
      description: 'Ground floor',
      expectedVersion: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: department.id,
      name: 'Physiotherapy',
      description: 'Ground floor',
      version: 2,
    });
    expect(await audited(hospital, department.id)).toEqual(['create', 'update']);
  });

  it('refuses a change made from an older version, and changes nothing', async () => {
    const department = await added('Renal');
    await change(department.id, { name: 'Nephrology', expectedVersion: 1 });

    const stale = await change(department.id, { name: 'Kidney Unit', expectedVersion: 1 });

    expect(errorOf(stale)).toEqual([409, 'conflict']);
    const { rows } = await pool.query('select name, version from departments where id = $1', [
      department.id,
    ]);
    expect(rows[0]).toEqual({ name: 'Nephrology', version: 2 });
  });

  it('writes nothing when what is sent is what it already has', async () => {
    const department = await added('Pathology', {}, 'Basement');

    const same = await change(department.id, {
      name: ' Pathology ',
      description: 'Basement',
      expectedVersion: 1,
    });

    expect(same.json()).toMatchObject({ version: 1 });
    expect(await audited(hospital, department.id)).toEqual(['create']);
  });

  it('lets a department change the capitals of its own name, but not take another’s', async () => {
    const department = await added('ent');

    expect((await change(department.id, { name: 'ENT', expectedVersion: 1 })).json()).toMatchObject(
      { name: 'ENT', version: 2 },
    );
    expect(
      errorOf(await change(department.id, { name: 'Cardiology', expectedVersion: 2 })),
    ).toEqual([409, 'department_name_taken']);
  });

  it('goes by the database’s idea of the same name, not JavaScript’s', async () => {
    // Postgres and JavaScript lower-case these differently (a dotted capital I, a final sigma).
    for (const name of ['İzmir Klinik', 'ΟΔΟΣ']) {
      const department = await added(name);

      const edited = await change(department.id, {
        name,
        description: 'Only the description changed',
        expectedVersion: 1,
      });

      expect(edited.statusCode, name).toBe(200);
      expect(edited.json(), name).toMatchObject({ name, version: 2 });
    }
  });

  it('lets one of two changes made from the same version through', async () => {
    const department = await added('Contested');

    const results = await Promise.all([
      change(department.id, { description: 'First', expectedVersion: 1 }),
      change(department.id, { description: 'Second', expectedVersion: 1 }),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const { rows } = await pool.query('select version from departments where id = $1', [
      department.id,
    ]);
    expect(rows[0]).toEqual({ version: 2 });
  });

  it('removes a description that is sent empty', async () => {
    const department = await added('Dental', {}, 'Old wing');

    const response = await change(department.id, { description: '', expectedVersion: 1 });

    expect(response.json<Department>().description).toBeUndefined();
  });

  it('archives and restores, and doing either twice changes nothing', async () => {
    const department = await added('Burns Unit');

    const archived = await act(department.id, 'archive');
    expect(archived.json()).toMatchObject({ archived: true, version: 2 });
    expect((await act(department.id, 'archive')).json()).toMatchObject({
      archived: true,
      version: 2,
    });

    const restored = await act(department.id, 'restore');
    expect(restored.json()).toMatchObject({ archived: false, version: 3 });
    expect(await audited(hospital, department.id)).toEqual(['create', 'archive', 'restore']);
  });
});

describe('access', () => {
  it('lets someone who may only read see the list and change nothing', async () => {
    const department = await added('Read Only Ward');
    const options = { user: doctor };

    expect((await list('', options)).statusCode).toBe(200);
    expect(errorOf(await add({ name: 'Nope' }, options))).toEqual([403, 'permission_denied']);
    expect(
      errorOf(await change(department.id, { name: 'Nope', expectedVersion: 1 }, options)),
    ).toEqual([403, 'permission_denied']);
    expect(errorOf(await act(department.id, 'archive', options))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('shows nothing to a role without the permission', async () => {
    expect(errorOf(await list('', { user: storeKeeper }))).toEqual([403, 'permission_denied']);
  });

  it('does not exist for a hospital with the module off', async () => {
    const options = { tenant: closed };

    expect(errorOf(await list('', options))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await add({ name: 'Nope' }, options))).toEqual([403, 'feature_disabled']);
  });

  it('needs a session', async () => {
    expect((await app.inject({ url: '/departments' })).statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('keeps each hospital’s departments to itself, and lets both use a name', async () => {
    const theirs = await added('Cardiology', { tenant: clinic });
    expect(theirs.tenantId).toBe(clinic.id);

    expect(names(await list('?limit=100', { tenant: clinic }))).toEqual(['Cardiology']);
    const ours = (await list('?limit=100')).json<Page>().items;
    expect(ours.every((item) => item.tenantId === hospital.id)).toBe(true);
    expect(ours.map((item) => item.id)).not.toContain(theirs.id);
  });

  it('has one answer for another hospital’s department and one that does not exist', async () => {
    const theirs = await added('Clinic Only', { tenant: clinic });

    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await change(id, { name: 'Taken Over', expectedVersion: 1 })), id).toEqual([
        404,
        'department_not_found',
      ]);
      expect(errorOf(await act(id, 'archive')), id).toEqual([404, 'department_not_found']);
    }
    const { rows } = await pool.query('select name, archived from departments where id = $1', [
      theirs.id,
    ]);
    expect(rows[0]).toEqual({ name: 'Clinic Only', archived: false });
  });

  it('is kept apart by the database itself, whatever the SQL', async () => {
    const theirs = await added('Clinic Secret', { tenant: clinic });

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      read: (await client.query('select 1 from departments where id = $1', [theirs.id])).rowCount,
      updated: (
        await client.query("update departments set name = 'Stolen' where id = $1", [theirs.id])
      ).rowCount,
      all: (await client.query<{ tenant_id: string }>('select distinct tenant_id from departments'))
        .rows,
    }));
    expect(seen).toEqual({ read: 0, updated: 0, all: [{ tenant_id: hospital.id }] });

    // Nor can a hospital put a department into another, move one, or delete its own.
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("insert into departments (tenant_id, name) values ($1, 'Planted')", [
          clinic.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenantSql(pool, hospital.id, (client) => client.query('delete from departments')),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('the text of a name and a description', () => {
  // Written by code point, so that this file holds no character that cannot be seen.
  const zeroWidth = String.fromCodePoint(0x200b);
  const override = String.fromCodePoint(0x202e);
  const composed = `Caf${String.fromCodePoint(0xe9)} Clinic`;
  const decomposed = `Cafe${String.fromCodePoint(0x301)} Clinic`;

  it('stores a name with single spaces and in one normal form, so the same name is one row', async () => {
    const response = await add({ name: '  Renal   Medicine ' });
    expect(response.json()).toMatchObject({ name: 'Renal Medicine' });
    expect(errorOf(await add({ name: 'renal  medicine' }))).toEqual([409, 'department_name_taken']);

    // An accented letter typed as a letter and a combining accent is the same name as the one
    // typed as a single character.
    expect((await add({ name: decomposed })).json()).toMatchObject({ name: composed });
    expect(errorOf(await add({ name: composed }))).toEqual([409, 'department_name_taken']);
  });

  it('refuses a name that would not read as it was typed', async () => {
    for (const name of [zeroWidth, `Ward${zeroWidth}A`, `Ward${override}A`, 'Two\nlines']) {
      expect((await add({ name })).statusCode, JSON.stringify(name)).toBe(400);
    }
    const hidden = await add({ name: 'Plain Enough', description: `Hidden${override}` });
    expect(hidden.statusCode).toBe(400);
  });

  it('keeps the lines of a description, each one tidied', async () => {
    const response = await add({
      name: 'Lined Department',
      description: '  First   line \r\n\r\n\r\n\r\n second line  \n',
    });
    expect(response.json()).toMatchObject({ description: 'First line\n\nsecond line' });
  });

  it('takes a name sent with other spacing as the name it already has', async () => {
    const department = (await add({ name: 'Spaced Out' })).json();
    const same = await change(department.id, { name: ' Spaced   Out ', expectedVersion: 1 });
    expect(same.json()).toMatchObject({ name: 'Spaced Out', version: 1 });
  });
});
