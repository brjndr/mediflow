import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  asTenantSql,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  grantRoleDefaults,
  testConfig,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { roleIdFrom } from './routes.js';

/**
 * Role management through the real app and database: reading, creating, editing and deleting
 * roles, built-in roles keeping their identity, the ceiling on what a role may hold, the
 * safeguards that leave a hospital able to manage itself, audit, the policy version, and the
 * hospital boundary.
 */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let solo: TestTenant;
let admin: TestUser;
let nurse: TestUser;
/** Holds the role permissions and a few others, but far less than an administrator. */
let desk: TestUser;
let clinicAdmin: TestUser;
let soloAdmin: TestUser;
const users: TestUser[] = [];
const tokens = new Map<string, string>();

async function newUser(name: string) {
  const user = await createUser(pool, name);
  users.push(user);
  return user;
}

async function signIn(user: TestUser): Promise<string> {
  const cached = tokens.get(user.id);
  if (cached) return cached;
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: user.email, password: user.password },
  });
  if (login.statusCode !== 200) throw new Error('sign-in failed in test setup');
  const token = login.cookies.find((cookie) => cookie.name === COOKIE)?.value ?? '';
  tokens.set(user.id, token);
  return token;
}

const call = async (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  user: TestUser,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    cookies: { [COOKIE]: await signIn(user) },
    headers: method === 'GET' ? {} : { origin: ORIGIN, 'idempotency-key': randomUUID() },
    ...(payload ? { payload } : {}),
  });
const errorOf = (response: LightMyRequestResponse) =>
  [response.statusCode, response.json().error.code] as const;

interface Detail {
  id: string;
  name: string;
  builtIn: boolean;
  memberCount: number;
  permissions: { permission: string; scope?: string }[];
}
const held = (response: LightMyRequestResponse) =>
  response
    .json<Detail>()
    .permissions.map((grant) => grant.permission)
    .sort();

const policyVersion = async (user: TestUser) =>
  (await call('GET', '/session/policy', user)).json<{ version: string }>().version;

const auditOf = async (tenant: TestTenant, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 and entity = 'role' and entity_id = $2 order by at",
      [tenant.id, entityId],
    )
  ).rows.map((row) => row.action);

async function customRole(tenant: TestTenant, id: string, permissions: string[]) {
  await pool.query('insert into roles (tenant_id, id, name) values ($1, $2, $3)', [
    tenant.id,
    id,
    id.replace('_', ' '),
  ]);
  for (const permission of permissions) {
    await pool.query(
      'insert into role_permissions (tenant_id, role_id, permission) values ($1, $2, $3)',
      [tenant.id, id, permission],
    );
  }
}

beforeAll(async () => {
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 } });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Roles Hospital');
  clinic = await createTenant(pool, 'Roles Clinic');
  solo = await createTenant(pool, 'Roles Solo');
  for (const tenant of [hospital, clinic, solo]) await grantRoleDefaults(app, tenant);
  await customRole(hospital, 'role_desk', ['role:read', 'role:manage', 'patient:read']);
  await customRole(hospital, 'hr_only', ['staff:read']);
  admin = await newUser('Roles Admin');
  nurse = await newUser('Roles Nurse');
  desk = await newUser('Roles Desk');
  clinicAdmin = await newUser('Roles Clinic Admin');
  soloAdmin = await newUser('Roles Solo Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, desk, hospital, 'role_desk');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, soloAdmin, solo, 'admin');
});

afterAll(async () => {
  await deleteUsers(pool, users);
  await deleteTenants(pool, [hospital, clinic, solo]);
  await app.close();
});

describe('reading roles', () => {
  it('lists the hospital roles, built-in first, with counts', async () => {
    const response = await call('GET', '/roles', admin);

    expect(response.statusCode).toBe(200);
    const items = response.json<{
      items: { id: string; builtIn: boolean; memberCount: number; permissionCount: number }[];
    }>().items;
    expect(items.slice(0, 8).every((role) => role.builtIn)).toBe(true);
    expect(items.find((role) => role.id === 'admin')?.memberCount).toBe(1);
    expect(items.find((role) => role.id === 'role_desk')).toMatchObject({
      builtIn: false,
      permissionCount: 3,
    });
  });

  it('gives one role with its permissions, and the catalog of everything that exists', async () => {
    const role = await call('GET', '/roles/role_desk', admin);
    const catalog = await call('GET', '/permission-catalog', admin);

    expect(held(role)).toEqual(['patient:read', 'role:manage', 'role:read']);
    const items = catalog.json<{ items: { permission: string; description: string }[] }>().items;
    expect(items.map((item) => item.permission)).toContain('role:manage');
    expect(items.every((item) => item.description.length > 0)).toBe(true);
  });

  it('is for those who hold role:read', async () => {
    expect(errorOf(await call('GET', '/roles', nurse))).toEqual([403, 'permission_denied']);
    expect(errorOf(await call('GET', '/permission-catalog', nurse))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('answers 404 for an unknown role', async () => {
    expect(errorOf(await call('GET', '/roles/nothing_here', admin))).toEqual([
      404,
      'role_not_found',
    ]);
  });
});

describe('the hospital boundary', () => {
  it("shows and changes none of another hospital's roles", async () => {
    expect(
      (await call('GET', '/roles', clinicAdmin)).json().items.map((r: { id: string }) => r.id),
    ).not.toContain('hr_only');
    expect(errorOf(await call('GET', '/roles/hr_only', clinicAdmin))).toEqual([
      404,
      'role_not_found',
    ]);
    expect(
      errorOf(await call('PUT', '/roles/hr_only', clinicAdmin, { name: 'Taken over' })),
    ).toEqual([404, 'role_not_found']);
    expect(errorOf(await call('DELETE', '/roles/hr_only', clinicAdmin))).toEqual([
      404,
      'role_not_found',
    ]);
    const untouched = await call('GET', '/roles/hr_only', admin);
    expect(untouched.json<Detail>().name).toBe('hr only');
  });

  it('is enforced by the database: no read, change or insert across hospitals', async () => {
    await asTenantSql(pool, clinic.id, async (db) => {
      const seen = await db.query("select 1 from roles where id = 'hr_only'");
      expect(seen.rowCount).toBe(0);
      const grants = await db.query("select 1 from role_permissions where role_id = 'hr_only'");
      expect(grants.rowCount).toBe(0);
      const renamed = await db.query("update roles set name = 'x' where id = 'hr_only'");
      expect(renamed.rowCount).toBe(0);
      const deleted = await db.query("delete from roles where id = 'hr_only'");
      expect(deleted.rowCount).toBe(0);
      await db.query('savepoint s');
      await expect(
        db.query("insert into roles (tenant_id, id, name) values ($1, 'planted', 'Planted')", [
          hospital.id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await db.query('rollback to savepoint s');
      await expect(
        db.query(
          "insert into role_permissions (tenant_id, role_id, permission) values ($1, 'hr_only', 'staff:manage')",
          [hospital.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('refuses at the database what the app role must never do to a built-in role', async () => {
    await asTenantSql(pool, hospital.id, async (db) => {
      await db.query('savepoint s');
      await expect(
        db.query("update roles set name = 'Boss' where id = 'admin'"),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query('rollback to savepoint s');
      await db.query('savepoint t');
      await expect(db.query("delete from roles where id = 'doctor'")).rejects.toMatchObject({
        code: '23514',
      });
      await db.query('rollback to savepoint t');
      await expect(
        db.query(
          "insert into roles (tenant_id, id, name, built_in) values ($1, 'sneaky', 'Sneaky', true)",
          [hospital.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('creating a role', () => {
  it('makes the id from the name, stores the grants, audits it and moves the policy version', async () => {
    const before = await policyVersion(admin);

    const response = await call('POST', '/roles', admin, {
      name: 'Billing  clerk',
      permissions: [{ permission: 'patient:read' }, { permission: 'staff:read', scope: 'own' }],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<Detail>()).toMatchObject({
      id: 'billing_clerk',
      name: 'Billing clerk',
      builtIn: false,
      permissions: [
        { permission: 'patient:read', scope: 'all' },
        { permission: 'staff:read', scope: 'own' },
      ],
    });
    expect(await auditOf(hospital, 'billing_clerk')).toEqual(['create']);
    expect(await policyVersion(admin)).not.toBe(before);
  });

  it('refuses a name or id that is taken, any case, built-in names included', async () => {
    await call('POST', '/roles', admin, { name: 'Ward helper', permissions: [] });

    for (const name of ['ward HELPER', 'Doctor', 'Administrator']) {
      expect(errorOf(await call('POST', '/roles', admin, { name, permissions: [] }))).toEqual([
        409,
        'role_exists',
      ]);
    }
  });

  it('refuses a bad permission list and a name with nothing to make an id of', async () => {
    const make = (name: string, permissions: object[]) =>
      call('POST', '/roles', admin, { name, permissions });

    expect(errorOf(await make('Odd', [{ permission: 'nothing:here' }]))).toEqual([
      400,
      'unknown_permission',
    ]);
    expect(
      errorOf(await make('Odd', [{ permission: 'patient:read' }, { permission: 'patient:read' }])),
    ).toEqual([400, 'duplicate_permission']);
    expect(errorOf(await make('***', []))).toEqual([400, 'validation_failed']);
    expect(errorOf(await call('PUT', '/roles/hr_only', admin, { name: '   ' }))).toEqual([
      400,
      'validation_failed',
    ]);
    expect(errorOf(await make('Platform admin', []))).toEqual([400, 'validation_failed']);
  });

  it('is repeatable with the same Idempotency-Key', async () => {
    const key = randomUUID();
    const send = async () =>
      app.inject({
        method: 'POST',
        url: '/roles',
        cookies: { [COOKIE]: await signIn(admin) },
        headers: { origin: ORIGIN, 'idempotency-key': key },
        payload: { name: 'Once only', permissions: [] },
      });

    const first = await send();
    const second = await send();

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<Detail>().id).toBe('once_only');
  });

  it('needs role:manage', async () => {
    expect(errorOf(await call('POST', '/roles', nurse, { name: 'X', permissions: [] }))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('derives ids safely', () => {
    expect(roleIdFrom('Nurse in charge')).toBe('nurse_in_charge');
    expect(roleIdFrom('  2nd shift  ')).toBe('role_2nd_shift');
    expect(roleIdFrom('हिन्दी')).toBeNull();
    expect(roleIdFrom('a'.repeat(100))?.length).toBeLessThanOrEqual(63);
  });
});

describe('nobody hands on more than they hold', () => {
  it('refuses a role with a permission the caller lacks', async () => {
    expect(
      errorOf(
        await call('POST', '/roles', desk, {
          name: 'Too much',
          permissions: [{ permission: 'staff:manage' }],
        }),
      ),
    ).toEqual([403, 'role_not_allowed']);
  });

  it('refuses a wider scope than the caller holds', async () => {
    await pool.query(
      "update role_permissions set scope = 'own' where tenant_id = $1 and role_id = 'role_desk' and permission = 'patient:read'",
      [hospital.id],
    );
    try {
      expect(
        errorOf(
          await call('POST', '/roles', desk, {
            name: 'Wider',
            permissions: [{ permission: 'patient:read', scope: 'all' }],
          }),
        ),
      ).toEqual([403, 'role_not_allowed']);
    } finally {
      await pool.query(
        "update role_permissions set scope = 'all' where tenant_id = $1 and role_id = 'role_desk'",
        [hospital.id],
      );
    }
  });

  it('refuses to edit or delete a role that holds more than the caller', async () => {
    expect(errorOf(await call('PUT', '/roles/admin', desk, { permissions: [] }))).toEqual([
      403,
      'role_not_allowed',
    ]);
    expect(errorOf(await call('PUT', '/roles/hr_only', desk, { name: 'Mine' }))).toEqual([
      403,
      'role_not_allowed',
    ]);
  });

  it('lets a caller raise a role they can fully hold, and no further', async () => {
    await call('POST', '/roles', desk, { name: 'Desk helper', permissions: [] });
    const within = await call('PUT', '/roles/desk_helper', desk, {
      permissions: [{ permission: 'patient:read' }],
    });
    expect(within.statusCode).toBe(200);
    expect(
      errorOf(
        await call('PUT', '/roles/desk_helper', desk, {
          permissions: [{ permission: 'patient:read' }, { permission: 'staff:manage' }],
        }),
      ),
    ).toEqual([403, 'role_not_allowed']);
  });
});

describe('built-in roles', () => {
  it('keep their name and cannot be deleted, but their permissions can change', async () => {
    expect(errorOf(await call('PUT', '/roles/nurse', admin, { name: 'Sister' }))).toEqual([
      409,
      'built_in_role',
    ]);
    expect(errorOf(await call('DELETE', '/roles/nurse', admin))).toEqual([409, 'built_in_role']);

    const before = await call('GET', '/roles/nurse', admin);
    const original = before.json<Detail>().permissions;
    try {
      const changed = await call('PUT', '/roles/nurse', admin, {
        name: 'Nurse',
        permissions: [...original, { permission: 'role:read' }],
      });
      expect(changed.statusCode).toBe(200);
      expect(held(changed)).toContain('role:read');
      expect(changed.json<Detail>().builtIn).toBe(true);
      expect(await auditOf(hospital, 'nurse')).toContain('update');
    } finally {
      await call('PUT', '/roles/nurse', admin, { permissions: original });
    }
  });

  it('does not get a removed default back from the next sync', async () => {
    const original = (await call('GET', '/roles/nurse', admin)).json<Detail>().permissions;
    const rest = original.filter((grant) => grant.permission !== 'patient:read');
    try {
      await call('PUT', '/roles/nurse', admin, { permissions: rest });
      await grantRoleDefaults(app, hospital);
      expect(held(await call('GET', '/roles/nurse', admin))).not.toContain('patient:read');
    } finally {
      await call('PUT', '/roles/nurse', admin, { permissions: original });
    }
  });
});

describe('editing and deleting a custom role', () => {
  it('renames, replaces the grants, and a user sees the new policy at once', async () => {
    await customRole(hospital, 'temp_role', ['patient:read']);
    await pool.query(
      "update roles set name = 'Temp role' where tenant_id = $1 and id = 'temp_role'",
      [hospital.id],
    );
    const user = await newUser('Roles Temp User');
    await addMembership(pool, user, hospital, 'temp_role');
    const before = await policyVersion(user);
    expect(
      (await call('GET', '/session/policy', user))
        .json<{ permissions: { permission: string }[] }>()
        .permissions.map((grant) => grant.permission),
    ).toEqual(['patient:read']);

    const response = await call('PUT', '/roles/temp_role', admin, {
      name: 'Temporary',
      permissions: [{ permission: 'staff:read' }],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Detail>()).toMatchObject({ name: 'Temporary', memberCount: 1 });
    expect(held(response)).toEqual(['staff:read']);
    const policy = await call('GET', '/session/policy', user);
    expect(policy.json<{ permissions: { permission: string }[] }>().permissions).toEqual([
      { permission: 'staff:read', scope: 'all' },
    ]);
    expect(policy.json<{ version: string }>().version).not.toBe(before);
  });

  it('refuses a name another role has', async () => {
    expect(errorOf(await call('PUT', '/roles/hr_only', admin, { name: 'doctor' }))).toEqual([
      409,
      'role_exists',
    ]);
  });

  it('deletes an unused custom role and audits it, but not one in use', async () => {
    await call('POST', '/roles', admin, { name: 'Short lived', permissions: [] });

    expect((await call('DELETE', '/roles/short_lived', admin)).statusCode).toBe(204);
    expect(errorOf(await call('GET', '/roles/short_lived', admin))).toEqual([
      404,
      'role_not_found',
    ]);
    expect(await auditOf(hospital, 'short_lived')).toEqual(['create', 'delete']);
    expect(errorOf(await call('DELETE', '/roles/role_desk', admin))).toEqual([409, 'role_in_use']);
  });

  it('keeps a role while an invitation names it', async () => {
    await call('POST', '/roles', admin, { name: 'Invited role', permissions: [] });
    await pool.query(
      `insert into invites (tenant_id, email, name, role_id, token_hash, expires_at)
       values ($1, 'roles-invite@staff.test', 'Invitee', 'invited_role', decode(repeat('ab', 32), 'hex'), now() + interval '1 day')`,
      [hospital.id],
    );
    try {
      expect(errorOf(await call('DELETE', '/roles/invited_role', admin))).toEqual([
        409,
        'role_in_use',
      ]);
    } finally {
      await pool.query("delete from invites where email = 'roles-invite@staff.test'");
    }
  });
});

describe('the hospital is never left unable to manage itself', () => {
  it('stops an administrator taking away their own ability to manage roles', async () => {
    const original = (await call('GET', '/roles/admin', clinicAdmin)).json<Detail>().permissions;
    const response = await call('PUT', '/roles/admin', clinicAdmin, {
      permissions: original.filter((grant) => grant.permission !== 'role:manage'),
    });

    expect(errorOf(response)).toEqual([409, 'cannot_remove_own_access']);
    expect(held(await call('GET', '/roles/admin', clinicAdmin))).toContain('role:manage');
  });

  it('stops a change that would leave nobody able to manage staff', async () => {
    const original = (await call('GET', '/roles/admin', soloAdmin)).json<Detail>().permissions;
    const response = await call('PUT', '/roles/admin', soloAdmin, {
      permissions: original.filter((grant) => grant.permission !== 'staff:manage'),
    });

    expect(errorOf(response)).toEqual([409, 'last_admin']);
    expect(held(await call('GET', '/roles/admin', soloAdmin))).toContain('staff:manage');
  });

  it('allows the change once someone else holds it', async () => {
    const deputy = await newUser('Roles Solo Deputy');
    await customRole(solo, 'deputy', ['staff:manage', 'staff:read']);
    await addMembership(pool, deputy, solo, 'deputy');
    const original = (await call('GET', '/roles/admin', soloAdmin)).json<Detail>().permissions;
    try {
      const response = await call('PUT', '/roles/admin', soloAdmin, {
        permissions: original.filter((grant) => grant.permission !== 'staff:manage'),
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await pool.query(
        "insert into role_permissions (tenant_id, role_id, permission) values ($1, 'admin', 'staff:manage') on conflict do nothing",
        [solo.id],
      );
    }
  });

  it('leaves nothing behind when a change is refused', async () => {
    const original = (await call('GET', '/roles/admin', clinicAdmin)).json<Detail>().permissions;
    await call('PUT', '/roles/admin', clinicAdmin, {
      name: 'Admin',
      permissions: original.filter((grant) => grant.permission !== 'role:manage'),
    });

    expect(await auditOf(clinic, 'admin')).toEqual([]);
    expect(held(await call('GET', '/roles/admin', clinicAdmin))).toEqual(
      original.map((grant) => grant.permission).sort(),
    );
  });
});
