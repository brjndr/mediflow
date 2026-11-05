import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
  buildTestApp,
  createUser,
  deleteUsers,
  resolveTestSession,
  TEST_PASSWORD,
  testConfig,
  type TestUser,
} from '../../../test/helpers.js';
import { bootstrapPlatformAdmin } from '../../core/platform/bootstrap.js';
import { PLATFORM_ROLE } from '../../core/platform/db.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
import { createMemoryNotifier } from '../../core/notifier/notifier.js';
import { prepareOffboarding } from './jobs.js';

/**
 * Platform administration, through the real app and database. Most requests are made as a user
 * the test resolver names; the onboarding flow at the end signs in with real cookies.
 */

const COOKIE = 'mediflow_session';
const config = testConfig({ AUTH_RATE_LIMIT_PER_MINUTE: 10_000 });
const ORIGIN = config.APP_BASE_URL;

const notifier = createMemoryNotifier(ORIGIN);
const queue = new MemoryQueue();
let app: FastifyInstance;
let cookieApp: FastifyInstance;
let pool: pg.Pool;
let operator: TestUser;
const users: TestUser[] = [];
const hospitals: string[] = [];

async function newUser(name: string, overrides: Parameters<typeof createUser>[2] = {}) {
  const user = await createUser(pool, name, overrides);
  users.push(user);
  return user;
}

/** A platform admin with a confirmed authenticator, as a platform route requires. */
async function newOperator(name: string, options: { mfa?: boolean } = {}) {
  const user = await newUser(name);
  await pool.query('update users set is_platform_admin = true where id = $1', [user.id]);
  if (options.mfa !== false) {
    await pool.query(
      "insert into user_mfa (user_id, secret_encrypted, confirmed_at) values ($1, '\\x00', now())",
      [user.id],
    );
  }
  return user;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession, notifier, jobQueue: queue });
  cookieApp = await buildTestApp({
    config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 },
    notifier,
    jobQueue: queue,
  });
  pool = app.database.pool;
  operator = await newOperator('Platform Pia');
});

afterAll(async () => {
  await pool.query('delete from tenants where id = any($1::uuid[])', [hospitals]);
  await pool.query("delete from users where email like '%@onboarded.test'");
  await deleteUsers(pool, users);
  await cookieApp.close();
  await app.close();
});

beforeEach(() => {
  notifier.sent.length = 0;
});

let counter = 0;
const body = (overrides: Record<string, unknown> = {}) => ({
  slug: `platform-test-${randomBytes(4).toString('hex')}-${counter++}`,
  name: 'Platform Test Hospital',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  themePrimary: '#0f766e',
  features: ['patients', 'wards'],
  ...overrides,
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  options: { as?: Record<string, string>; payload?: object; key?: string } = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(options.as ?? as(null, operator.id)),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.payload ? { payload: options.payload } : {}),
  });

const code = (response: LightMyRequestResponse) => response.json().error.code as string;
let keyCounter = 0;
const freshKey = () => `test-key-${randomBytes(6).toString('hex')}-${keyCounter++}`;

async function createHospital(overrides: Record<string, unknown> = {}) {
  const response = await call('POST', '/platform/hospitals', {
    payload: body(overrides),
    key: freshKey(),
  });
  expect(response.statusCode, response.body).toBe(201);
  const hospital = response.json<{ id: string; version: number; slug: string }>();
  hospitals.push(hospital.id);
  return hospital;
}

describe('who may call a platform route', () => {
  it('refuses a request with no session', async () => {
    const response = await app.inject({ url: '/platform/hospitals' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses hospital staff, whatever their role holds', async () => {
    const hospital = await createHospital();
    const staff = await newUser('Admin Anil');
    await pool.query('select seed_built_in_roles($1)', [hospital.id]);
    await addMembership(pool, staff, { id: hospital.id, slug: hospital.slug, name: 'x' }, 'admin');
    for (const asUser of [as(hospital.id, staff.id), as(null, staff.id)]) {
      const response = await call('GET', '/platform/hospitals', { as: asUser });
      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe('forbidden');
    }
  });

  it('refuses a platform admin who has no authenticator, and one who is disabled', async () => {
    const bare = await newOperator('Platform Bare', { mfa: false });
    const unconfirmed = await newOperator('Platform Half', { mfa: false });
    await pool.query("insert into user_mfa (user_id, secret_encrypted) values ($1, '\\x00')", [
      unconfirmed.id,
    ]);
    for (const user of [bare, unconfirmed]) {
      const response = await call('GET', '/platform/hospitals', { as: as(null, user.id) });
      expect(response.statusCode).toBe(403);
      expect(code(response)).toBe('mfa_required');
    }

    const disabled = await newOperator('Platform Gone');
    await pool.query("update users set status = 'disabled' where id = $1", [disabled.id]);
    const response = await call('GET', '/platform/hospitals', { as: as(null, disabled.id) });
    expect(response.statusCode).toBe(403);
  });

  it('lets a platform admin with an authenticator in', async () => {
    const response = await call('GET', '/platform/hospitals');
    expect(response.statusCode).toBe(200);
  });

  it('gives a platform admin no way into a hospital’s own routes', async () => {
    const hospital = await createHospital();
    const noHospital = await call('GET', '/tenant');
    expect(noHospital.statusCode).toBe(409);
    expect(code(noHospital)).toBe('no_active_tenant');
    // Naming a hospital in the session does not help: there is no membership to grant anything.
    const named = await call('GET', '/departments', { as: as(hospital.id, operator.id) });
    expect(named.statusCode).toBe(403);
  });
});

describe('what the platform role can reach in the database', () => {
  async function asPlatform<T>(run: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${PLATFORM_ROLE}`);
      return await run(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it('cannot read patient rows, or any other table that holds hospital data (tested)', async () => {
    await createHospital();
    for (const table of [
      'patients',
      'encounters',
      'invoices',
      'appointments',
      'audit_log',
      'outbox',
      'sessions',
      'user_identities',
    ]) {
      await expect(
        asPlatform((client) => client.query(`select 1 from ${table} limit 1`)),
        table,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('holds grants on the tables named here and no others', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants
       where grantee = $1 and table_schema = 'public'
       union
       select distinct table_name from information_schema.column_privileges
       where grantee = $1 and table_schema = 'public'`,
      [PLATFORM_ROLE],
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      'invites',
      'memberships',
      'platform_audit_log',
      'platform_requests',
      'role_default_grants',
      'role_permissions',
      'roles',
      'tenant_features',
      'tenants',
    ]);
  });

  it('cannot read an invite’s token hash, or write a user, a session or a membership', async () => {
    await expect(
      asPlatform((client) => client.query('select token_hash from invites')),
    ).rejects.toMatchObject({ code: '42501' });
    for (const statement of [
      "insert into users (email, name, is_platform_admin) values ('x@y.test', 'X', true)",
      'update users set is_platform_admin = true',
      "insert into memberships (tenant_id, user_id, role_id) select id, gen_random_uuid(), 'admin' from tenants",
      'delete from memberships',
    ]) {
      await expect(
        asPlatform((client) => client.query(statement)),
        statement,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps the platform’s trail append-only', async () => {
    await createHospital();
    await expect(pool.query('update platform_audit_log set action = action')).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('delete from platform_audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('creating a hospital', () => {
  it('creates it active with its roles, their permissions and the modules asked for', async () => {
    const payload = body({ region: 'in', maxUsers: 50, features: ['patients', 'mfa'] });
    const response = await call('POST', '/platform/hospitals', { payload, key: freshKey() });
    expect(response.statusCode).toBe(201);
    const hospital = response.json();
    hospitals.push(hospital.id);
    expect(hospital).toMatchObject({
      slug: payload.slug,
      status: 'active',
      authMode: 'password',
      region: 'in',
      maxUsers: 50,
      storageMb: null,
      version: 1,
      memberCount: 0,
      features: [
        { feature: 'mfa', enabled: true },
        { feature: 'patients', enabled: true },
      ],
    });

    const roles = await pool.query<{ id: string }>(
      'select id from roles where tenant_id = $1 and built_in',
      [hospital.id],
    );
    expect(roles.rows.map((row) => row.id)).toContain('admin');
    const grants = await pool.query(
      "select 1 from role_permissions where tenant_id = $1 and role_id = 'admin'",
      [hospital.id],
    );
    expect(grants.rowCount).toBeGreaterThan(0);
  });

  it('is repeatable with the same key, and refuses the key for another request', async () => {
    const payload = body();
    const key = freshKey();
    const first = await call('POST', '/platform/hospitals', { payload, key });
    expect(first.statusCode).toBe(201);
    hospitals.push(first.json().id);
    const again = await call('POST', '/platform/hospitals', { payload, key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);

    const other = await call('POST', '/platform/hospitals', { payload: body(), key });
    expect(other.statusCode).toBe(422);
    expect(code(other)).toBe('idempotency_key_reuse');

    const count = await pool.query('select 1 from tenants where slug = $1', [payload.slug]);
    expect(count.rowCount).toBe(1);
  });

  it('needs an Idempotency-Key', async () => {
    const response = await call('POST', '/platform/hospitals', { payload: body() });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a slug that is taken, an unknown module, and values that are not real', async () => {
    const taken = await createHospital();
    const duplicate = await call('POST', '/platform/hospitals', {
      payload: body({ slug: taken.slug }),
      key: freshKey(),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(code(duplicate)).toBe('slug_taken');

    const refused: [Record<string, unknown>, string][] = [
      [{ features: ['patients', 'nope'] }, 'unknown_feature'],
      [{ timezone: 'Mars/Olympus' }, 'validation_failed'],
      [{ currency: 'ZZZ' }, 'validation_failed'],
      [{ locale: 'not a tag' }, 'validation_failed'],
      [{ slug: 'Not A Slug' }, 'validation_failed'],
      [{ themePrimary: 'teal' }, 'validation_failed'],
      [{ maxUsers: 0 }, 'validation_failed'],
    ];
    for (const [overrides, expected] of refused) {
      const response = await call('POST', '/platform/hospitals', {
        payload: body(overrides),
        key: freshKey(),
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(code(response)).toBe(expected);
    }
    // None of the refusals left a hospital behind.
    const left = await pool.query(
      "select 1 from tenants where slug like 'platform-test-%' and name = 'Platform Test Hospital' and id <> all($1::uuid[])",
      [hospitals],
    );
    expect(left.rowCount).toBe(0);
  });

  it('writes to the platform’s trail, with ids and codes only', async () => {
    const hospital = await createHospital({ name: 'Secret Name Hospital' });
    const { rows } = await pool.query(
      'select actor_id, action, entity, hospital_id, detail from platform_audit_log where hospital_id = $1',
      [hospital.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: operator.id,
      action: 'hospital.create',
      entity: 'hospital',
      hospital_id: hospital.id,
      detail: { modules: 2 },
    });
    expect(JSON.stringify(rows)).not.toContain('Secret Name');
  });
});

describe('reading hospitals', () => {
  it('lists them newest first a page at a time, and filters', async () => {
    const tag = randomBytes(3).toString('hex');
    const made = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      made.push(await createHospital({ name: `${name} ${tag} Clinic` }));
    }
    const first = await call('GET', `/platform/hospitals?limit=2&q=${tag}`);
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(page1.items.map((item) => item.id)).toEqual([made[2]?.id, made[1]?.id]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await call(
      'GET',
      `/platform/hospitals?limit=2&q=${tag}&cursor=${page1.nextCursor}`,
    );
    const page2 = second.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(page2.items.map((item) => item.id)).toEqual([made[0]?.id]);
    expect(page2.nextCursor).toBeNull();

    const suspended = await call('GET', `/platform/hospitals?q=${tag}&status=suspended`);
    expect(suspended.json().items).toEqual([]);

    const bad = await call('GET', '/platform/hospitals?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(400);
  });

  it('shows one hospital, and a plain 404 for one that does not exist', async () => {
    const hospital = await createHospital();
    const found = await call('GET', `/platform/hospitals/${hospital.id}`);
    expect(found.statusCode).toBe(200);
    expect(found.json().slug).toBe(hospital.slug);

    const missing = await call('GET', '/platform/hospitals/6f1b1f0e-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(404);
    const malformed = await call('GET', '/platform/hospitals/nope');
    expect(malformed.statusCode).toBe(400);
  });
});

describe('editing a hospital', () => {
  it('changes only what was sent, moves the version, and refuses a stale one', async () => {
    const hospital = await createHospital({ address: 'Old Road' });
    const edit = await call('PATCH', `/platform/hospitals/${hospital.id}`, {
      payload: { version: 1, name: 'Renamed Hospital', maxUsers: 10, address: null },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({
      name: 'Renamed Hospital',
      maxUsers: 10,
      address: null,
      currency: 'INR',
      version: 2,
    });

    const stale = await call('PATCH', `/platform/hospitals/${hospital.id}`, {
      payload: { version: 1, name: 'Too late' },
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('version_conflict');

    const empty = await call('PATCH', `/platform/hospitals/${hospital.id}`, {
      payload: { version: 2 },
    });
    expect(empty.statusCode).toBe(400);

    const audit = await pool.query(
      "select detail from platform_audit_log where hospital_id = $1 and action = 'hospital.update'",
      [hospital.id],
    );
    expect(audit.rows[0]?.detail).toEqual({ fields: 'address,maxUsers,name' });
  });

  it('switches modules on and off, which moves the hospital’s policy', async () => {
    const hospital = await createHospital({ features: ['patients'] });
    const before = await pool.query<{ policy_revision: string }>(
      'select policy_revision from tenants where id = $1',
      [hospital.id],
    );
    const response = await call('PUT', `/platform/hospitals/${hospital.id}/features`, {
      payload: {
        features: [
          { feature: 'patients', enabled: false },
          { feature: 'wards', enabled: true },
          { feature: 'mfa_required', enabled: true },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().features).toEqual([
      { feature: 'mfa_required', enabled: true },
      { feature: 'patients', enabled: false },
      { feature: 'wards', enabled: true },
    ]);
    const after = await pool.query<{ policy_revision: string }>(
      'select policy_revision from tenants where id = $1',
      [hospital.id],
    );
    expect(BigInt(after.rows[0]?.policy_revision ?? 0)).toBeGreaterThan(
      BigInt(before.rows[0]?.policy_revision ?? 0),
    );

    const actions = await pool.query(
      "select action, detail->>'feature' as feature from platform_audit_log where hospital_id = $1 and action like 'hospital.feature_%' order by action, 2",
      [hospital.id],
    );
    expect(actions.rows).toEqual([
      { action: 'hospital.feature_off', feature: 'patients' },
      { action: 'hospital.feature_on', feature: 'mfa_required' },
      { action: 'hospital.feature_on', feature: 'wards' },
    ]);

    const unknown = await call('PUT', `/platform/hospitals/${hospital.id}/features`, {
      payload: { features: [{ feature: 'nope', enabled: true }] },
    });
    expect(unknown.statusCode).toBe(400);
    const missing = await call(
      'PUT',
      '/platform/hospitals/6f1b1f0e-0000-4000-8000-000000000000/features',
      {
        payload: { features: [{ feature: 'wards', enabled: true }] },
      },
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe('the first admin', () => {
  it('is invited by email, accepts, signs in and finds the hospital', async () => {
    const hospital = await createHospital({ features: ['patients'] });
    const email = `first.admin.${randomBytes(3).toString('hex')}@onboarded.test`;
    const invited = await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: { name: 'First Admin', email: email.toUpperCase() },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({ email });

    // The email is sent by a job once the request has committed.
    await queue.drain();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.to).toBe(email);
    const token = notifier.sent[0]?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeDefined();

    const accepted = await cookieApp.inject({
      method: 'POST',
      url: '/auth/invite/accept',
      headers: { origin: ORIGIN },
      payload: { token, password: TEST_PASSWORD },
    });
    expect(accepted.statusCode).toBe(204);

    const login = await cookieApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const session = login.json();
    expect(session.activeTenant.id).toBe(hospital.id);
    expect(session.user.memberships[0].roleId).toBe('admin');
    expect(
      session.policy.permissions.some(
        (grant: { permission: string }) => grant.permission === 'patient:read',
      ),
    ).toBe(true);

    const audit = await pool.query(
      "select 1 from platform_audit_log where hospital_id = $1 and action = 'hospital.admin_invited'",
      [hospital.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('withdraws an earlier invite to the same address, and needs an active hospital', async () => {
    const hospital = await createHospital();
    const email = `twice.${randomBytes(3).toString('hex')}@onboarded.test`;
    for (let i = 0; i < 2; i++) {
      const response = await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
        payload: { name: 'Twice', email },
      });
      expect(response.statusCode).toBe(201);
    }
    const open = await pool.query(
      'select 1 from invites where tenant_id = $1 and accepted_at is null and revoked_at is null',
      [hospital.id],
    );
    expect(open.rowCount).toBe(1);

    const badEmail = await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: { name: 'Nobody', email: 'not an address' },
    });
    expect(badEmail.statusCode).toBe(400);

    await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    const closed = await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: { name: 'Late', email: `late.${randomBytes(3).toString('hex')}@onboarded.test` },
    });
    expect(closed.statusCode).toBe(409);
    expect(code(closed)).toBe('hospital_not_active');
  });
});

describe('suspending, reactivating and offboarding', () => {
  /** A hospital with a signed-in member, using real cookies. */
  async function hospitalWithMember() {
    const hospital = await createHospital({ features: ['patients'] });
    const member = await newUser('Member Mira');
    await addMembership(
      pool,
      member,
      { id: hospital.id, slug: hospital.slug, name: 'x' },
      'doctor',
    );
    const login = await cookieApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: member.email, password: member.password },
    });
    const token = login.cookies.find((cookie) => cookie.name === COOKIE)?.value ?? '';
    const tenant = () => cookieApp.inject({ url: '/tenant', cookies: { [COOKIE]: token } });
    expect((await tenant()).statusCode).toBe(200);
    return { hospital, member, tenant };
  }

  it('closes the hospital to its staff at once, and opens it again', async () => {
    const { hospital, tenant } = await hospitalWithMember();
    const suspended = await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ status: 'suspended', version: 2 });
    expect(suspended.json().suspendedAt).not.toBeNull();

    // Signed out of it: the session ended, not only the routes refused.
    expect((await tenant()).statusCode).toBe(401);
    const ended = await pool.query(
      'select count(*)::int as n from sessions where active_tenant_id = $1 and revoked_at is null',
      [hospital.id],
    );
    expect(ended.rows[0]?.n).toBe(0);

    const again = await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('invalid_transition');

    const reactivated = await call('POST', `/platform/hospitals/${hospital.id}/reactivate`);
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json()).toMatchObject({ status: 'active', suspendedAt: null });
    const notSuspended = await call('POST', `/platform/hospitals/${hospital.id}/reactivate`);
    expect(code(notSuspended)).toBe('invalid_transition');

    const trail = await pool.query(
      "select action from platform_audit_log where hospital_id = $1 and action in ('hospital.suspend', 'hospital.reactivate') order by at",
      [hospital.id],
    );
    expect(trail.rows.map((row) => row.action)).toEqual([
      'hospital.suspend',
      'hospital.reactivate',
    ]);
  });

  it('answers 403 tenant_suspended to a staff request that is already in', async () => {
    const hospital = await createHospital();
    const staff = await newUser('Staff Sam');
    await addMembership(pool, staff, { id: hospital.id, slug: hospital.slug, name: 'x' }, 'admin');
    const open = await call('GET', '/tenant', { as: as(hospital.id, staff.id) });
    expect(open.statusCode).toBe(200);
    await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    const closed = await call('GET', '/tenant', { as: as(hospital.id, staff.id) });
    expect(closed.statusCode).toBe(403);
    expect(code(closed)).toBe('tenant_suspended');
  });

  it('offboards: closes it, marks it for deletion, withdraws invites and signs staff out', async () => {
    const { hospital, tenant } = await hospitalWithMember();
    await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: {
        name: 'Pending',
        email: `pending.${randomBytes(3).toString('hex')}@onboarded.test`,
      },
    });

    const refused = await call('POST', `/platform/hospitals/${hospital.id}/offboard`, {
      payload: { deleteAfterDays: 0 },
    });
    expect(refused.statusCode).toBe(400);

    const response = await call('POST', `/platform/hospitals/${hospital.id}/offboard`, {
      payload: { deleteAfterDays: 30 },
    });
    expect(response.statusCode).toBe(200);
    const offboarding = response.json();
    expect(offboarding.status).toBe('offboarding');
    expect(offboarding.offboardingRequestedAt).not.toBeNull();
    const days =
      (Date.parse(offboarding.deleteAfter) - Date.parse(offboarding.offboardingRequestedAt)) /
      86_400_000;
    expect(Math.round(days)).toBe(30);
    expect((await tenant()).statusCode).toBe(401);

    // The invites went with the status change, not later.
    const open = await pool.query(
      'select 1 from invites where tenant_id = $1 and accepted_at is null and revoked_at is null',
      [hospital.id],
    );
    expect(open.rowCount).toBe(0);

    // The sweep finds nothing left to do, so it adds nothing to the trail, however often it runs.
    await queue.drain();
    expect(
      await prepareOffboarding(pool, { hospitalId: hospital.id, requestedBy: operator.id }),
    ).toBe(true);
    const swept = await pool.query(
      "select 1 from platform_audit_log where hospital_id = $1 and action = 'hospital.offboard_swept'",
      [hospital.id],
    );
    expect(swept.rowCount).toBe(0);

    // Staff of an offboarding hospital cannot use it, signed in or not.
    const staff = await newUser('Staff Late');
    await addMembership(pool, staff, { id: hospital.id, slug: hospital.slug, name: 'x' }, 'admin');
    const blocked = await call('GET', '/tenant', { as: as(hospital.id, staff.id) });
    expect(code(blocked)).toBe('tenant_suspended');

    // Cancelled before it ran: reactivate clears the dates, and the job then does nothing.
    const back = await call('POST', `/platform/hospitals/${hospital.id}/reactivate`);
    expect(back.json()).toMatchObject({
      status: 'active',
      offboardingRequestedAt: null,
      deleteAfter: null,
    });
    expect(
      await prepareOffboarding(pool, { hospitalId: hospital.id, requestedBy: operator.id }),
    ).toBe(false);
  });

  it('cannot offboard twice', async () => {
    const hospital = await createHospital();
    const url = `/platform/hospitals/${hospital.id}/offboard`;
    expect((await call('POST', url, { payload: { deleteAfterDays: 30 } })).statusCode).toBe(200);
    const again = await call('POST', url, { payload: { deleteAfterDays: 30 } });
    expect(again.statusCode).toBe(409);
  });
});

describe('suspension and the first admin', () => {
  it('withdraws open invites when the hospital is suspended', async () => {
    const hospital = await createHospital();
    await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: { name: 'Pending', email: `p.${randomBytes(3).toString('hex')}@onboarded.test` },
    });
    await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    const open = await pool.query(
      'select 1 from invites where tenant_id = $1 and accepted_at is null and revoked_at is null',
      [hospital.id],
    );
    expect(open.rowCount).toBe(0);
  });

  it('offboards a suspended hospital, and reactivating clears every date', async () => {
    const hospital = await createHospital();
    await call('POST', `/platform/hospitals/${hospital.id}/suspend`);
    const offboard = await call('POST', `/platform/hospitals/${hospital.id}/offboard`, {
      payload: { deleteAfterDays: 7 },
    });
    expect(offboard.statusCode).toBe(200);
    const back = await call('POST', `/platform/hospitals/${hospital.id}/reactivate`);
    expect(back.json()).toMatchObject({
      status: 'active',
      suspendedAt: null,
      offboardingRequestedAt: null,
      deleteAfter: null,
    });
  });

  it('invites only until the hospital has an admin, and never a platform admin', async () => {
    const hospital = await createHospital();
    const url = `/platform/hospitals/${hospital.id}/admin-invite`;
    const own = await call('POST', url, {
      payload: { name: 'Operator', email: operator.email.toUpperCase() },
    });
    expect(own.statusCode).toBe(400);

    const admin = await newUser('Admin Ana');
    await addMembership(pool, admin, { id: hospital.id, slug: hospital.slug, name: 'x' }, 'admin');
    const refused = await call('POST', url, {
      payload: { name: 'Second', email: `s.${randomBytes(3).toString('hex')}@onboarded.test` },
    });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('hospital_has_admin');

    // An admin who is suspended does not count: the hospital can be given a new one.
    await pool.query("update memberships set status = 'suspended' where user_id = $1", [admin.id]);
    const again = await call('POST', url, {
      payload: { name: 'Third', email: `t.${randomBytes(3).toString('hex')}@onboarded.test` },
    });
    expect(again.statusCode).toBe(201);
  });

  it('records who was invited as a domain and a short hash, never the address', async () => {
    const hospital = await createHospital();
    const email = `traced.${randomBytes(3).toString('hex')}@onboarded.test`;
    await call('POST', `/platform/hospitals/${hospital.id}/admin-invite`, {
      payload: { name: 'Traced', email },
    });
    const { rows } = await pool.query(
      "select detail from platform_audit_log where hospital_id = $1 and action = 'hospital.admin_invited'",
      [hospital.id],
    );
    expect(rows[0]?.detail).toMatchObject({ domain: 'onboarded.test' });
    expect(rows[0]?.detail.emailHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows)).not.toContain('traced.');
  });
});

describe('details of the routes', () => {
  it('refuses a cursor that is not one, including an impossible date', async () => {
    const impossible = Buffer.from(
      JSON.stringify({ at: '2026-99-99 00:00:00+00', id: '6f1b1f0e-0000-4000-8000-000000000000' }),
    ).toString('base64url');
    for (const cursor of ['not-a-cursor', impossible]) {
      for (const path of ['/platform/hospitals', '/platform/audit']) {
        const response = await call('GET', `${path}?cursor=${cursor}`);
        expect(response.statusCode, path).toBe(400);
        expect(code(response)).toBe('invalid_cursor');
      }
    }
  });

  it('pages through hospitals made in the same instant without losing or repeating one', async () => {
    const tag = randomBytes(3).toString('hex');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createHospital({ name: `Tie ${tag} ${i}` })).id);
    await pool.query('update tenants set created_at = now() where id = any($1::uuid[])', [ids]);
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const response = await call('GET', `/platform/hospitals?limit=1&q=${tag}${cursor}`);
      const body = response.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...body.items.map((item) => item.id));
      if (!body.nextCursor) break;
      cursor = `&cursor=${body.nextCursor}`;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('searches for the text typed, so a percent sign or underscore means itself', async () => {
    const tag = randomBytes(3).toString('hex');
    await createHospital({ name: `Percent ${tag} 100% Care` });
    const literal = await call('GET', `/platform/hospitals?q=${encodeURIComponent('100%')}`);
    expect(literal.json().items.length).toBeGreaterThan(0);
    const wild = await call('GET', `/platform/hospitals?q=${encodeURIComponent('zz%zz_')}`);
    expect(wild.json().items).toEqual([]);
  });

  it('stores a time zone as the runtime names it', async () => {
    const hospital = await createHospital({ timezone: 'asia/kolkata' });
    const found = await call('GET', `/platform/hospitals/${hospital.id}`);
    expect(found.json().timezone).toBe('Asia/Calcutta');
  });

  it('adds nothing to the trail when a module is set to what it already is', async () => {
    const hospital = await createHospital({ features: ['patients'] });
    const url = `/platform/hospitals/${hospital.id}/features`;
    const payload = { features: [{ feature: 'patients', enabled: true }] };
    await call('PUT', url, { payload });
    const rows = await pool.query(
      "select 1 from platform_audit_log where hospital_id = $1 and action like 'hospital.feature_%'",
      [hospital.id],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('serialises two requests with one key into one hospital', async () => {
    const payload = body();
    const key = freshKey();
    const [a, b] = await Promise.all([
      call('POST', '/platform/hospitals', { payload, key }),
      call('POST', '/platform/hospitals', { payload, key }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().id).toBe(b.json().id);
    hospitals.push(a.json().id);
    const count = await pool.query('select 1 from tenants where slug = $1', [payload.slug]);
    expect(count.rowCount).toBe(1);
  });

  it('treats the same request with its fields in another order as the same', async () => {
    const payload = body();
    const key = freshKey();
    const first = await call('POST', '/platform/hospitals', { payload, key });
    hospitals.push(first.json().id);
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    const again = await call('POST', '/platform/hospitals', { payload: reordered, key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });
});

describe('the platform’s trail', () => {
  it('lists what was done to a hospital, newest first', async () => {
    const hospital = await createHospital();
    await call('PATCH', `/platform/hospitals/${hospital.id}`, {
      payload: { version: 1, name: 'Audited Hospital' },
    });
    await call('POST', `/platform/hospitals/${hospital.id}/suspend`);

    const response = await call('GET', `/platform/audit?hospitalId=${hospital.id}&limit=2`);
    expect(response.statusCode).toBe(200);
    const page = response.json<{ items: { action: string }[]; nextCursor: string | null }>();
    expect(page.items.map((item) => item.action)).toEqual(['hospital.suspend', 'hospital.update']);
    expect(page.nextCursor).not.toBeNull();
    const rest = await call(
      'GET',
      `/platform/audit?hospitalId=${hospital.id}&limit=2&cursor=${page.nextCursor}`,
    );
    expect(rest.json().items.map((item: { action: string }) => item.action)).toEqual([
      'hospital.create',
    ]);
  });
});

describe('the first platform admin', () => {
  it('is made by the bootstrap command, can set a password, and still needs an authenticator', async () => {
    const email = `bootstrap.${randomBytes(3).toString('hex')}@onboarded.test`;
    const result = await bootstrapPlatformAdmin(pool, { email, name: 'Bootstrap Bea' });
    expect(result.created).toBe(true);
    const token = result.linkPath.match(/token=([A-Za-z0-9_-]{43})/)?.[1];

    // No password is known yet, so nothing signs in.
    const early = await cookieApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: TEST_PASSWORD },
    });
    expect(early.statusCode).toBe(401);

    const reset = await cookieApp.inject({
      method: 'POST',
      url: '/auth/password/reset',
      headers: { origin: ORIGIN },
      payload: { token, password: TEST_PASSWORD },
    });
    expect(reset.statusCode).toBe(204);

    const login = await cookieApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((entry) => entry.name === COOKIE)?.value ?? '';
    const route = await cookieApp.inject({
      url: '/platform/hospitals',
      cookies: { [COOKIE]: cookie },
    });
    expect(route.statusCode).toBe(403);
    expect(route.json().error.code).toBe('mfa_required');

    // Run again for the same address: a new link, not a second account.
    const again = await bootstrapPlatformAdmin(pool, { email, name: 'Bootstrap Bea' });
    expect(again.created).toBe(false);
    const accounts = await pool.query('select 1 from users where email = $1', [email]);
    expect(accounts.rowCount).toBe(1);
  });

  it('refuses an address that belongs to hospital staff', async () => {
    const staff = await newUser('Staff Stan');
    await expect(
      bootstrapPlatformAdmin(pool, { email: staff.email, name: 'Staff Stan' }),
    ).rejects.toThrow(/hospital staff/);
    const row = await pool.query('select is_platform_admin from users where id = $1', [staff.id]);
    expect(row.rows[0]?.is_platform_admin).toBe(false);
  });
});
