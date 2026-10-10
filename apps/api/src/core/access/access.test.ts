import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { withAuthTransaction } from '../auth/db.js';
import { createMemoryNotifier } from '../notifier/notifier.js';
import { loadPolicy, type AccessPolicy } from './policy.js';
import {
  createPermissionRegistry,
  PermissionRegistryError,
  type PermissionDefinition,
} from './registry.js';
import { syncRoleDefaults } from './sync.js';

/**
 * Roles, permissions and the guard, through the real app and database, signed in by cookie.
 *
 * `probe` is a test-only feature declared exactly as a real one would be: permissions with
 * default grants, and routes that state what they require.
 */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;
const PERMISSION_DENIED = /permission denied/;

const PROBE_PERMISSIONS = [
  { id: 'probe:read', description: 'Read probes', defaults: { admin: 'all', doctor: 'own' } },
  { id: 'probe:write', description: 'Write probes', defaults: { admin: 'all' } },
] as const satisfies readonly PermissionDefinition[];

const notifier = createMemoryNotifier(ORIGIN);
let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
/** A doctor at both hospitals. */
let doctor: TestUser;
let nurse: TestUser;
/** In a role the clinic made for itself. */
let clerk: TestUser;
let afterCommitRuns = 0;

beforeAll(async () => {
  app = await buildTestApp({
    notifier,
    config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 },
    extend(instance) {
      instance.permissions.register('probe', PROBE_PERMISSIONS);
      instance.get('/open', { config: { permissions: [] } }, async () => ({ ok: true }));
      instance.get('/probes', { config: { permissions: ['probe:read'] } }, async (request) => ({
        scope: request.access.scope('probe:read'),
      }));
      instance.post(
        '/probes',
        { config: { permissions: ['probe:read', 'probe:write'] } },
        async () => ({ ok: true }),
      );
      instance.get(
        '/lab',
        { config: { permissions: ['probe:read'], feature: 'laboratory' } },
        async () => ({ ok: true }),
      );
      instance.get(
        '/lab/open',
        { config: { permissions: [], feature: 'laboratory' } },
        async () => ({
          ok: true,
        }),
      );
      instance.get('/sloppy', { config: { permissions: ['probe:read'] } }, async (request) => ({
        scope: request.access.scope('probe:write'),
      }));
      instance.post<{ Body: { fail?: boolean } }>(
        '/after-commit',
        { config: { permissions: [] } },
        async (request) => {
          request.afterCommit(async () => {
            afterCommitRuns++;
          });
          if (request.body.fail) throw new Error('handler failed');
          return { ok: true };
        },
      );
    },
  });
  pool = app.database.pool;

  hospital = await createTenant(pool, 'Access Hospital', { features: { laboratory: true } });
  clinic = await createTenant(pool, 'Access Clinic', { features: { laboratory: false } });
  await grantRoleDefaults(app, hospital);
  await grantRoleDefaults(app, clinic);
  await pool.query(
    "insert into roles (tenant_id, id, name) values ($1, 'billing_clerk', 'Billing clerk')",
    [clinic.id],
  );
  await pool.query(
    "insert into role_permissions (tenant_id, role_id, permission, scope) values ($1, 'billing_clerk', 'probe:read', 'department')",
    [clinic.id],
  );

  admin = await createUser(pool, 'Access Admin');
  doctor = await createUser(pool, 'Access Doctor');
  nurse = await createUser(pool, 'Access Nurse');
  clerk = await createUser(pool, 'Access Clerk');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clerk, clinic, 'billing_clerk');
});

afterAll(async () => {
  await pool.query("delete from users where email like '%@access-invited.test'");
  await deleteUsers(pool, [admin, doctor, nurse, clerk]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

beforeEach(() => {
  notifier.sent.length = 0;
});

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === COOKIE)?.value ?? '';

/** Signs in, picking a hospital for someone who works at several. Returns the cookie's token. */
async function signIn(user: TestUser, at?: TestTenant): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: user.email, password: user.password },
  });
  if (login.statusCode !== 200) throw new Error('sign-in failed in test setup');
  if (!at) return cookieOf(login);
  const switched = await app.inject({
    method: 'POST',
    url: '/session/switch-tenant',
    headers: { origin: ORIGIN },
    cookies: { [COOKIE]: cookieOf(login) },
    payload: { tenantId: at.id },
  });
  if (switched.statusCode !== 200) throw new Error('switch failed in test setup');
  return cookieOf(switched);
}

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, cookies: { [COOKIE]: token }, headers });
const post = (url: string, token: string, payload: object = {}) =>
  app.inject({
    method: 'POST',
    url,
    cookies: { [COOKIE]: token },
    headers: { origin: ORIGIN },
    payload,
  });
const errorOf = (response: LightMyRequestResponse) =>
  [response.statusCode, response.json().error.code] as const;
const policyOf = async (token: string) =>
  (await get('/session/policy', token)).json<AccessPolicy>();

describe('the access policy', () => {
  it('comes with the session: the role, its permissions and the hospital modules', async () => {
    const token = await signIn(admin);

    const session = (await get('/session', token)).json<{ policy: AccessPolicy }>();

    expect(session.policy).toEqual({
      tenantId: hospital.id,
      roleId: 'admin',
      permissions: [
        { permission: 'probe:read', scope: 'all' },
        { permission: 'probe:write', scope: 'all' },
        { permission: 'staff:invite', scope: 'all' },
      ],
      features: { laboratory: true },
      version: expect.stringMatching(new RegExp(`^${hospital.id}\\.admin\\.\\d+$`)),
    });
  });

  it('is null until someone who works at several hospitals picks one', async () => {
    const token = await signIn(doctor);

    const session = (await get('/session', token)).json<{ policy: AccessPolicy | null }>();
    const policy = await get('/session/policy', token);

    expect(session.policy).toBeNull();
    expect(errorOf(policy)).toEqual([409, 'no_active_tenant']);
  });

  it('differs per hospital for the same person', async () => {
    const atHospital = await policyOf(await signIn(doctor, hospital));
    const atClinic = await policyOf(await signIn(doctor, clinic));

    expect(atHospital).toMatchObject({ tenantId: hospital.id, features: { laboratory: true } });
    expect(atClinic).toMatchObject({ tenantId: clinic.id, features: { laboratory: false } });
    expect(atHospital.permissions).toEqual([{ permission: 'probe:read', scope: 'own' }]);
    expect(atHospital.version).not.toBe(atClinic.version);
  });

  it('carries the permissions of a role the hospital made for itself', async () => {
    const policy = await policyOf(await signIn(clerk));

    expect(policy).toMatchObject({
      roleId: 'billing_clerk',
      permissions: [{ permission: 'probe:read', scope: 'department' }],
    });
  });

  it('is served with an ETag, and costs nothing to re-check while unchanged', async () => {
    const token = await signIn(nurse);

    const first = await get('/session/policy', token);
    const etag = String(first.headers.etag);
    const unchanged = await get('/session/policy', token, { 'if-none-match': etag });
    const stale = await get('/session/policy', token, { 'if-none-match': '"something-old"' });

    expect(first.statusCode).toBe(200);
    expect(etag).toBe(`"${first.json<AccessPolicy>().version}"`);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
    expect(unchanged.headers.etag).toBe(etag);
    expect(stale.statusCode).toBe(200);
  });

  it('needs a session, and refuses a stale tab naming another hospital', async () => {
    const token = await signIn(nurse);

    const anonymous = await app.inject({ method: 'GET', url: '/session/policy' });
    const stale = await get('/session/policy', token, { 'x-tenant-id': clinic.id });

    expect(errorOf(anonymous)).toEqual([401, 'unauthenticated']);
    expect(errorOf(stale)).toEqual([409, 'tenant_mismatch']);
  });
});

describe('the policy version', () => {
  const versionOf = async (token: string) => (await policyOf(token)).version;

  it.each([
    [
      'a permission is granted to a role',
      "insert into role_permissions (tenant_id, role_id, permission) values ($1, 'nurse', 'probe:read')",
    ],
    [
      'the scope of a grant changes',
      "update role_permissions set scope = 'own' where tenant_id = $1 and role_id = 'nurse' and permission = 'probe:read'",
    ],
    [
      'a permission is taken away',
      "delete from role_permissions where tenant_id = $1 and role_id = 'nurse' and permission = 'probe:read'",
    ],
    [
      'a role is renamed',
      "update roles set name = 'Staff nurse' where tenant_id = $1 and id = 'nurse'",
    ],
    [
      'a role is added',
      "insert into roles (tenant_id, id, name) values ($1, 'ward_clerk', 'Ward clerk')",
    ],
    ['a role is removed', "delete from roles where tenant_id = $1 and id = 'ward_clerk'"],
    [
      'a module is switched on',
      "insert into tenant_features (tenant_id, feature, enabled) values ($1, 'pharmacy', true)",
    ],
    [
      'a module is switched off',
      "update tenant_features set enabled = false where tenant_id = $1 and feature = 'pharmacy'",
    ],
  ])('moves when %s', async (_what, statement) => {
    const token = await signIn(nurse);
    const before = await get('/session/policy', token);

    await pool.query(statement, [hospital.id]);

    const after = await get('/session/policy', token, {
      'if-none-match': String(before.headers.etag),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json<AccessPolicy>().version).not.toBe(before.json<AccessPolicy>().version);
  });

  it('moves when the user is given another role', async () => {
    const mover = await createUser(pool, 'Access Mover');
    await addMembership(pool, mover, hospital, 'nurse');
    try {
      const token = await signIn(mover);
      const before = await versionOf(token);

      await pool.query("update memberships set role_id = 'doctor' where user_id = $1", [mover.id]);

      const after = await policyOf(token);
      expect(after.version).not.toBe(before);
      expect(after.permissions).toEqual([{ permission: 'probe:read', scope: 'own' }]);
    } finally {
      await deleteUsers(pool, [mover]);
    }
  });

  it('does not move for another hospital', async () => {
    const token = await signIn(doctor, clinic);
    const before = await versionOf(token);

    await pool.query(
      "update roles set name = 'Senior nurse' where tenant_id = $1 and id = 'nurse'",
      [hospital.id],
    );

    expect(await versionOf(token)).toBe(before);
  });
});

describe('the guard', () => {
  it('lets a route open to members through for anyone at the hospital', async () => {
    expect((await get('/open', await signIn(nurse))).statusCode).toBe(200);
  });

  it('refuses a route to a role without the permission', async () => {
    const response = await get('/probes', await signIn(nurse));

    expect(errorOf(response)).toEqual([403, 'permission_denied']);
  });

  it('lets the permission through and tells the handler its scope', async () => {
    const asAdmin = await get('/probes', await signIn(admin));
    const asDoctor = await get('/probes', await signIn(doctor, hospital));
    const asClerk = await get('/probes', await signIn(clerk));

    expect(asAdmin.json()).toEqual({ scope: 'all' });
    expect(asDoctor.json()).toEqual({ scope: 'own' });
    expect(asClerk.json()).toEqual({ scope: 'department' });
  });

  it('needs every permission a route lists', async () => {
    const asDoctor = await post('/probes', await signIn(doctor, hospital));
    const asAdmin = await post('/probes', await signIn(admin));

    expect(errorOf(asDoctor)).toEqual([403, 'permission_denied']);
    expect(asAdmin.statusCode).toBe(200);
  });

  it('refuses a module that is off for the hospital, whatever the role holds', async () => {
    const atHospital = await get('/lab', await signIn(doctor, hospital));
    const atClinic = await get('/lab', await signIn(doctor, clinic));
    const openAtClinic = await get('/lab/open', await signIn(doctor, clinic));

    expect(atHospital.statusCode).toBe(200);
    expect(errorOf(atClinic)).toEqual([403, 'feature_disabled']);
    expect(errorOf(openAtClinic)).toEqual([403, 'feature_disabled']);
  });

  it('follows a change to the role on the very next request', async () => {
    const token = await signIn(doctor, clinic);
    expect((await get('/probes', token)).statusCode).toBe(200);

    await pool.query(
      "delete from role_permissions where tenant_id = $1 and role_id = 'doctor' and permission = 'probe:read'",
      [clinic.id],
    );

    expect(errorOf(await get('/probes', token))).toEqual([403, 'permission_denied']);
    // The same role at the other hospital is untouched.
    expect((await get('/probes', await signIn(doctor, hospital))).statusCode).toBe(200);
  });

  it('needs a session before anything else', async () => {
    const response = await app.inject({ method: 'GET', url: '/probes' });

    expect(errorOf(response)).toEqual([401, 'unauthenticated']);
  });

  it('fails loudly when a handler asks about a permission its route never declared', async () => {
    const response = await get('/sloppy', await signIn(admin));

    expect(response.statusCode).toBe(500);
  });
});

describe('starting the app', () => {
  it('refuses a tenant route that does not say what it requires', async () => {
    await expect(
      buildTestApp({
        extend(instance) {
          instance.get('/forgotten', async () => ({ ok: true }));
        },
      }),
    ).rejects.toThrow(/GET \/forgotten is a tenant route without `config.permissions`/);
  });

  it('refuses a route that requires a permission no feature declares', async () => {
    await expect(
      buildTestApp({
        extend(instance) {
          instance.get('/typo', { config: { permissions: ['probe:raed'] } }, async () => ({}));
        },
      }),
    ).rejects.toThrow(/GET \/typo requires "probe:raed", which no feature declares/);
  });

  it('does not ask public and session routes for permissions', async () => {
    const other = await buildTestApp({
      extend(instance) {
        instance.get('/hello', { config: { access: 'public' } }, async () => ({ ok: true }));
      },
    });
    try {
      expect((await other.inject({ url: '/hello' })).statusCode).toBe(200);
    } finally {
      await other.close();
    }
  });
});

describe('the permission registry', () => {
  it('lists what every feature declared, with its owner', () => {
    expect(app.permissions.all().map(({ id, feature }) => `${feature}/${id}`)).toEqual(
      expect.arrayContaining(['staff/staff:invite', 'probe/probe:read', 'probe/probe:write']),
    );
    expect(app.permissions.has('probe:read')).toBe(true);
    expect(app.permissions.has('probe:delete')).toBe(false);
  });

  it('refuses malformed ids, duplicates and defaults for roles that do not exist', () => {
    const registry = createPermissionRegistry();
    registry.register('patients', [{ id: 'patient:read', description: 'Read patients' }]);

    const bad = () =>
      registry.register('billing', [
        { id: 'patient:read', description: 'Clashes with patients' },
        { id: 'Refund' as 'x:y', description: 'Not resource:action' },
        { id: 'invoice:void', description: 'Twice' },
        { id: 'invoice:void', description: 'Twice' },
        {
          id: 'invoice:read',
          description: 'Unknown role',
          defaults: { cashier: 'all' } as PermissionDefinition['defaults'],
        },
      ]);

    expect(bad).toThrow(PermissionRegistryError);
    try {
      bad();
    } catch (error) {
      expect((error as PermissionRegistryError).problems).toEqual([
        'billing: "patient:read" is already declared by patients',
        'billing: "Refund" is not resource:action',
        'billing: "invoice:void" is already declared by billing',
        'billing: "invoice:read" has a default for unknown role cashier',
      ]);
    }
    // Nothing from a refused declaration is kept.
    expect(registry.has('invoice:void')).toBe(false);
  });
});

describe('default grants for built-in roles', () => {
  const grants = async (tenant: TestTenant, roleId: string) =>
    (
      await pool.query<{ permission: string }>(
        'select permission from role_permissions where tenant_id = $1 and role_id = $2 order by 1',
        [tenant.id, roleId],
      )
    ).rows.map((row) => row.permission);

  it('every new hospital has the built-in roles', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'select id from roles where tenant_id = $1 and built_in order by id',
      [hospital.id],
    );

    expect(rows.map((row) => row.id)).toEqual([
      'admin',
      'doctor',
      'lab_technician',
      'nurse',
      'pharmacist',
      'radiologist',
      'receptionist',
      'store_keeper',
    ]);
  });

  it('are applied once: running again adds nothing', async () => {
    expect(await syncRoleDefaults(pool, app.permissions.all(), hospital.id)).toBe(0);
    expect(await syncRoleDefaults(pool, app.permissions.all(), clinic.id)).toBe(0);
  });

  it('do not put back a grant the hospital removed', async () => {
    await pool.query(
      "delete from role_permissions where tenant_id = $1 and role_id = 'admin' and permission = 'probe:write'",
      [clinic.id],
    );

    await syncRoleDefaults(pool, app.permissions.all(), clinic.id);

    expect(await grants(clinic, 'admin')).toEqual(['probe:read', 'staff:invite']);
  });

  it('deliver a later feature’s permissions to built-in roles, and leave custom roles alone', async () => {
    const later: PermissionDefinition[] = [
      { id: 'probe:export', description: 'Added later', defaults: { admin: 'all', nurse: 'own' } },
    ];

    const added = await syncRoleDefaults(pool, later, clinic.id);

    expect(added).toBe(2);
    expect(await grants(clinic, 'admin')).toContain('probe:export');
    expect(await grants(clinic, 'nurse')).toEqual(['probe:export']);
    expect(await grants(clinic, 'billing_clerk')).toEqual(['probe:read']);
    // Only the hospital that was asked for.
    expect(await grants(hospital, 'admin')).not.toContain('probe:export');
  });
});

describe('roles and tenant isolation', () => {
  it('shows a hospital only its own roles and grants, read-only', async () => {
    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      tenants: (await client.query<{ tenant_id: string }>('select distinct tenant_id from roles'))
        .rows,
      custom: (await client.query("select 1 from roles where id = 'billing_clerk'")).rowCount,
      grants: (
        await client.query<{ tenant_id: string }>('select distinct tenant_id from role_permissions')
      ).rows,
    }));

    expect(seen).toEqual({
      tenants: [{ tenant_id: hospital.id }],
      custom: 0,
      grants: [{ tenant_id: hospital.id }],
    });
    for (const statement of [
      "insert into role_permissions (tenant_id, role_id, permission) values (app_tenant_id(), 'nurse', 'probe:write')",
      "update role_permissions set scope = 'all'",
      "insert into roles (tenant_id, id, name) values (app_tenant_id(), 'superuser', 'Superuser')",
      'delete from roles',
      'update tenants set policy_revision = 1',
    ]) {
      await expect(
        asTenantSql(pool, hospital.id, (client) => client.query(statement)),
        statement,
      ).rejects.toThrow(PERMISSION_DENIED);
    }
  });

  it('gives no policy for a hospital other than the transaction’s own, whatever is asked', async () => {
    const inHospital = await asTenantSql(pool, hospital.id, async (client) => ({
      own: await loadPolicy(client, hospital.id, doctor.id),
      other: await loadPolicy(client, clinic.id, doctor.id),
      malformed: await loadPolicy(client, "x' or '1'='1", doctor.id),
    }));

    expect(inHospital.own?.tenantId).toBe(hospital.id);
    expect(inHospital.other).toBeNull();
    expect(inHospital.malformed).toBeNull();
  });

  it('lets authentication read only the hospitals of the user it has identified', async () => {
    const seen = await withAuthTransaction(pool, async ({ client, identify }) => {
      await identify(nurse.id);
      return {
        roles: (await client.query<{ tenant_id: string }>('select distinct tenant_id from roles'))
          .rows,
        // The nurse is not a member of the clinic, so asking for it finds nothing.
        clinic: await loadPolicy(client, clinic.id, nurse.id),
        // Nor can one user's transaction read another user's policy.
        someoneElse: await loadPolicy(client, hospital.id, admin.id),
      };
    });

    expect(seen.roles).toEqual([{ tenant_id: hospital.id }]);
    expect(seen.clinic).toBeNull();
    expect(seen.someoneElse).toBeNull();
  });

  it('ties a membership to a role the hospital has', async () => {
    await expect(
      pool.query("update memberships set role_id = 'billing_clerk' where user_id = $1", [nurse.id]),
    ).rejects.toThrow(/memberships_role/);
  });
});

describe('inviting staff', () => {
  let invitee = 0;
  const freshEmail = () => `invitee.${Date.now()}.${invitee++}@access-invited.test`;
  const invite = (token: string, payload: object) => post('/invites', token, payload);

  it('lets an admin invite someone, and emails the link once the invite is saved', async () => {
    const email = freshEmail();

    const response = await invite(await signIn(admin), {
      email: ` ${email.toUpperCase()} `,
      name: 'New Nurse',
      roleId: 'nurse',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.any(String),
      email,
      roleId: 'nurse',
      expiresInHours: 168,
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ to: email, template: 'invite' });
    // The link is in the email only.
    const token = notifier.sent[0]?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? '';
    expect(response.body).not.toContain(token);

    const preview = await app.inject({
      method: 'POST',
      url: '/auth/invite/inspect',
      headers: { origin: ORIGIN },
      payload: { token },
    });
    expect(preview.json()).toMatchObject({ email, hospitalName: 'Access Hospital' });
    const { rows } = await pool.query<{ tenant_id: string; invited_by: string }>(
      'select tenant_id, invited_by from invites where email = $1',
      [email],
    );
    expect(rows).toEqual([{ tenant_id: hospital.id, invited_by: admin.id }]);
  });

  it('refuses a role without the permission, and nothing is created or sent', async () => {
    const email = freshEmail();

    const response = await invite(await signIn(nurse), { email, name: 'X', roleId: 'admin' });

    expect(errorOf(response)).toEqual([403, 'permission_denied']);
    expect(notifier.sent).toHaveLength(0);
    expect((await pool.query('select 1 from invites where email = $1', [email])).rowCount).toBe(0);
  });

  it('accepts only a role of this hospital', async () => {
    const token = await signIn(admin);

    const unknown = await invite(token, { email: freshEmail(), name: 'X', roleId: 'wizard' });
    // A real role, but the clinic's own.
    const foreign = await invite(token, {
      email: freshEmail(),
      name: 'X',
      roleId: 'billing_clerk',
    });

    expect(errorOf(unknown)).toEqual([400, 'unknown_role']);
    expect(errorOf(foreign)).toEqual([400, 'unknown_role']);
    expect(notifier.sent).toHaveLength(0);
  });

  it('refuses something that is not one email address', async () => {
    const token = await signIn(admin);

    for (const email of ['not-an-email', 'a@x.test, b@y.test', 'Mallory <m@evil.test>']) {
      const response = await invite(token, { email, name: 'X', roleId: 'nurse' });
      expect(errorOf(response), email).toEqual([400, 'validation_failed']);
    }
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('work after the commit', () => {
  it('runs when the request succeeds and not when it fails', async () => {
    const token = await signIn(nurse);
    afterCommitRuns = 0;

    const failed = await post('/after-commit', token, { fail: true });
    expect(failed.statusCode).toBe(500);
    expect(afterCommitRuns).toBe(0);

    const succeeded = await post('/after-commit', token, {});
    expect(succeeded.statusCode).toBe(200);
    expect(afterCommitRuns).toBe(1);
  });
});
