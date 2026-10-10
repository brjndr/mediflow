import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  testConfig,
  TEST_PASSWORD,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { withAuthTransaction } from './db.js';
import { hashToken, ROTATION_GRACE_SECONDS } from './sessions.js';

/**
 * Sign-in and sessions, through the real app and the real database: no session resolver is
 * injected here, so every request is authenticated by its cookie.
 */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let elsewhere: TestTenant;
/** Works at the hospital only. */
let nurse: TestUser;
/** Works at the hospital and the clinic. */
let doctor: TestUser;
/** Has an account and no hospital. */
let newcomer: TestUser;
let disabled: TestUser;
const extraUsers: TestUser[] = [];

beforeAll(async () => {
  // The address limit is tested on its own app below; here it must not get in the way.
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 } });
  pool = app.database.pool;

  hospital = await createTenant(pool, 'Auth Hospital', { features: { laboratory: true } });
  clinic = await createTenant(pool, 'Auth Clinic', { currency: 'AED' });
  elsewhere = await createTenant(pool, 'Auth Elsewhere');

  nurse = await createUser(pool, 'Nurse Nila');
  doctor = await createUser(pool, 'Doctor Dev');
  newcomer = await createUser(pool, 'Newcomer Noor');
  disabled = await createUser(pool, 'Disabled Dan', { status: 'disabled' });
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, disabled, hospital, 'nurse');
});

afterAll(async () => {
  await deleteUsers(pool, [nurse, doctor, newcomer, disabled, ...extraUsers]);
  await deleteTenants(pool, [hospital, clinic, elsewhere]);
  await app.close();
});

const login = (email: string, password: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password },
    ...(cookie ? { cookies: { [COOKIE]: cookie } } : {}),
  });

const sessionCookie = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === COOKIE);

/** Signs in and returns the cookie's token. */
async function signIn(user: TestUser): Promise<string> {
  const response = await login(user.email, user.password);
  const token = sessionCookie(response)?.value;
  if (response.statusCode !== 200 || !token) throw new Error('sign-in failed in test setup');
  return token;
}

const getSession = (token: string) =>
  app.inject({ method: 'GET', url: '/session', cookies: { [COOKIE]: token } });

const sessionRow = async (token: string) => {
  const { rows } = await pool.query<{
    id: string;
    active_tenant_id: string | null;
    revoke_reason: string | null;
  }>(
    'select id, active_tenant_id, revoke_reason from sessions where token_hash = $1 or previous_token_hash = $1',
    [hashToken(token)],
  );
  return rows[0];
};

/** Moves a session's clocks back, as if that much time had passed. */
const age = (
  token: string,
  column: 'last_seen_at' | 'rotated_at' | 'expires_at',
  interval: string,
) =>
  pool.query(
    `update sessions set ${column} = ${column} - $2::interval where token_hash = $1 or previous_token_hash = $1`,
    [hashToken(token), interval],
  );

describe('signing in', () => {
  it('starts a session and returns it as a cookie scripts cannot read', async () => {
    const response = await login(nurse.email, nurse.password);

    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBeUndefined();
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The token travels in the cookie only.
    expect(response.body).not.toContain(cookie?.value);
  });

  it('answers with the user, their hospitals and the active one', async () => {
    const response = await login(nurse.email, nurse.password);

    expect(response.json()).toEqual({
      user: {
        id: nurse.id,
        email: nurse.email,
        name: 'Nurse Nila',
        memberships: [{ tenantId: hospital.id, tenantName: 'Auth Hospital', roleId: 'nurse' }],
        mfaEnabled: false,
      },
      activeTenant: expect.objectContaining({
        id: hospital.id,
        name: 'Auth Hospital',
        features: { laboratory: true },
      }),
      // No feature has given the nurse role anything in this test hospital.
      policy: {
        tenantId: hospital.id,
        roleId: 'nurse',
        permissions: [],
        features: { laboratory: true },
        version: expect.stringMatching(/\.nurse\.\d+$/),
      },
    });
  });

  it('stores a hash of the token, not the token', async () => {
    const token = await signIn(nurse);

    const { rows } = await pool.query<{ token_hash: Buffer }>(
      'select token_hash from sessions where user_id = $1',
      [nurse.id],
    );
    const stored = rows.map((row) => row.token_hash.toString('hex'));
    expect(stored).toContain(hashToken(token).toString('hex'));
    expect(stored).not.toContain(Buffer.from(token).toString('hex'));
  });

  it('accepts the email in any case and with stray spaces', async () => {
    const response = await login(`  ${nurse.email.toUpperCase()} `, nurse.password);

    expect(response.statusCode).toBe(200);
  });

  it('leaves no hospital active for someone who works at several', async () => {
    const response = await login(doctor.email, doctor.password);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: {
        memberships: [
          { tenantId: clinic.id, tenantName: 'Auth Clinic' },
          { tenantId: hospital.id, tenantName: 'Auth Hospital' },
        ],
      },
      activeTenant: null,
      policy: null,
    });
  });

  it('signs in someone with no hospital, who then sees none', async () => {
    const response = await login(newcomer.email, newcomer.password);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { memberships: [] }, activeTenant: null });
  });

  it('ends the session the browser already had', async () => {
    const first = await signIn(nurse);

    const response = await login(nurse.email, nurse.password, first);

    expect(response.statusCode).toBe(200);
    expect(sessionCookie(response)?.value).not.toBe(first);
    expect((await getSession(first)).statusCode).toBe(401);
    expect((await sessionRow(first))?.revoke_reason).toBe('replaced');
  });
});

describe('a failed sign-in', () => {
  it('has one answer whatever was wrong, so it cannot be used to find accounts', async () => {
    const noPassword = await createUser(pool, 'Sso Only', { withPassword: false });
    extraUsers.push(noPassword);

    const responses = await Promise.all([
      login('nobody.here@staff.test', TEST_PASSWORD),
      login(nurse.email, 'not the right password'),
      login(disabled.email, disabled.password),
      login(noPassword.email, TEST_PASSWORD),
      login(nurse.email, 'x'.repeat(200)),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({
        code: 'invalid_credentials',
        message: responses[0]?.json().error.message,
      });
      expect(sessionCookie(response)).toBeUndefined();
    }
  });

  it('refuses a request that is not an email and a password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: nurse.email },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('account lockout', () => {
  const lockState = async (user: TestUser) => {
    const { rows } = await pool.query<{ failed_login_count: number; locked: boolean }>(
      'select failed_login_count, (locked_until > now()) is true as locked from users where id = $1',
      [user.id],
    );
    return rows[0];
  };

  it('locks after five wrong passwords, and then refuses the right one too', async () => {
    const user = await createUser(pool, 'Locked Lata');
    extraUsers.push(user);

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await login(user.email, 'wrong password here')).statusCode).toBe(401);
    }
    expect(await lockState(user)).toEqual({ failed_login_count: 4, locked: false });

    const fifth = await login(user.email, 'wrong password here');
    expect(await lockState(user)).toEqual({ failed_login_count: 0, locked: true });

    const whileLocked = await login(user.email, user.password);
    expect(whileLocked.statusCode).toBe(401);
    // Locked looks the same as wrong.
    expect(whileLocked.json().error.code).toBe(fifth.json().error.code);
    expect(whileLocked.json().error.message).toBe(fifth.json().error.message);
  });

  it('counts parallel guesses one by one', async () => {
    const user = await createUser(pool, 'Parallel Pia');
    extraUsers.push(user);

    await Promise.all(Array.from({ length: 5 }, () => login(user.email, 'wrong password here')));

    expect(await lockState(user)).toEqual({ failed_login_count: 0, locked: true });
  });

  it('lets the user in again once the lock has passed', async () => {
    const user = await createUser(pool, 'Patient Paro');
    extraUsers.push(user);
    for (let attempt = 1; attempt <= 5; attempt++) await login(user.email, 'wrong password here');

    await pool.query("update users set locked_until = now() - interval '1 second' where id = $1", [
      user.id,
    ]);

    expect((await login(user.email, user.password)).statusCode).toBe(200);
  });

  it('forgets earlier mistakes after a successful sign-in', async () => {
    const user = await createUser(pool, 'Forgetful Fay');
    extraUsers.push(user);
    for (let attempt = 1; attempt <= 3; attempt++) await login(user.email, 'wrong password here');

    expect((await login(user.email, user.password)).statusCode).toBe(200);

    expect(await lockState(user)).toEqual({ failed_login_count: 0, locked: false });
  });
});

describe('the sign-in rate limit', () => {
  it('refuses further attempts from one address, with the standard error body', async () => {
    const limited = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 3 } });
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { origin: ORIGIN },
          payload: { email: 'nobody.here@staff.test', password: 'wrong password here' },
        });
      for (let count = 1; count <= 3; count++) expect((await attempt()).statusCode).toBe(401);

      const refused = await attempt();

      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('rate_limited');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Other routes are not limited by it.
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('the session', () => {
  it('is what GET /session returns, and is never cached', async () => {
    const token = await signIn(nurse);

    const response = await getSession(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      user: { id: nurse.id },
      activeTenant: { id: hospital.id },
    });
  });

  it('is required: no cookie, or a made-up one, is a 401', async () => {
    const none = await app.inject({ method: 'GET', url: '/session' });
    const forged = await getSession('A'.repeat(43));
    const malformed = await getSession("' or 1=1 --");

    for (const response of [none, forged, malformed]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('unauthenticated');
    }
  });

  it('opens tenant routes for the active hospital only', async () => {
    const token = await signIn(nurse);

    const own = await app.inject({ method: 'GET', url: '/tenant', cookies: { [COOKIE]: token } });
    const other = await app.inject({
      method: 'GET',
      url: '/tenant',
      cookies: { [COOKIE]: token },
      // Naming another hospital changes nothing but the answer.
      headers: { 'x-tenant-id': clinic.id },
    });

    expect(own.json()).toMatchObject({ id: hospital.id });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('tenant_mismatch');
  });

  it('ends after 30 minutes without a request', async () => {
    const token = await signIn(nurse);
    await age(token, 'last_seen_at', '29 minutes');
    expect((await getSession(token)).statusCode).toBe(200);

    await age(token, 'last_seen_at', '31 minutes');
    const response = await getSession(token);

    expect(response.statusCode).toBe(401);
    expect((await sessionRow(token))?.revoke_reason).toBe('idle');
    // The browser is told to drop the cookie.
    expect(sessionCookie(response)?.value).toBe('');
    // And it stays ended, however soon the next request comes.
    expect((await getSession(token)).statusCode).toBe(401);
  });

  it('ends after 12 hours however active it is', async () => {
    const token = await signIn(nurse);
    await age(token, 'expires_at', '12 hours');

    expect((await getSession(token)).statusCode).toBe(401);
    expect((await sessionRow(token))?.revoke_reason).toBe('expired');
  });

  it('ends when the account is disabled', async () => {
    const user = await createUser(pool, 'Leaving Leo');
    extraUsers.push(user);
    await addMembership(pool, user, hospital);
    const token = await signIn(user);

    await pool.query("update users set status = 'disabled' where id = $1", [user.id]);

    expect((await getSession(token)).statusCode).toBe(401);
    expect((await sessionRow(token))?.revoke_reason).toBe('admin');
  });

  it('loses its hospital when the membership is suspended', async () => {
    const user = await createUser(pool, 'Moving Mira');
    extraUsers.push(user);
    await addMembership(pool, user, hospital);
    const token = await signIn(user);

    await pool.query("update memberships set status = 'suspended' where user_id = $1", [user.id]);

    const session = await getSession(token);
    expect(session.json()).toMatchObject({ user: { memberships: [] }, activeTenant: null });
    const tenant = await app.inject({
      method: 'GET',
      url: '/tenant',
      cookies: { [COOKIE]: token },
    });
    expect(tenant.statusCode).toBe(409);
    expect(tenant.json().error.code).toBe('no_active_tenant');
  });
});

describe('token rotation', () => {
  it('replaces the token after 15 minutes and sends the new one', async () => {
    const token = await signIn(nurse);
    expect(sessionCookie(await getSession(token))).toBeUndefined();

    await age(token, 'rotated_at', '16 minutes');
    const response = await getSession(token);

    expect(response.statusCode).toBe(200);
    const next = sessionCookie(response)?.value;
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(token);
    expect((await getSession(next ?? '')).statusCode).toBe(200);
  });

  it('still accepts the old token for requests that were already on their way', async () => {
    const token = await signIn(nurse);
    await age(token, 'rotated_at', '16 minutes');
    await getSession(token);

    const inFlight = await getSession(token);

    expect(inFlight.statusCode).toBe(200);
    // It is not handed yet another token.
    expect(sessionCookie(inFlight)).toBeUndefined();
  });

  it('ends the session for everyone when a replaced token turns up later', async () => {
    const token = await signIn(nurse);
    await age(token, 'rotated_at', '16 minutes');
    const next = sessionCookie(await getSession(token))?.value ?? '';

    // Past the grace period, the old token can only be a copy.
    await age(token, 'rotated_at', `${ROTATION_GRACE_SECONDS + 1} seconds`);
    const reused = await getSession(token);

    expect(reused.statusCode).toBe(401);
    expect((await sessionRow(next))?.revoke_reason).toBe('token_reuse');
    expect((await getSession(next)).statusCode).toBe(401);
  });
});

describe('switching hospital', () => {
  const switchTo = (token: string, tenantId: string) =>
    app.inject({
      method: 'POST',
      url: '/session/switch-tenant',
      headers: { origin: ORIGIN },
      cookies: { [COOKIE]: token },
      payload: { tenantId },
    });

  it('binds the session to the chosen hospital and replaces the token', async () => {
    const token = await signIn(doctor);

    const response = await switchTo(token, clinic.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ activeTenant: { id: clinic.id, currency: 'AED' } });
    const next = sessionCookie(response)?.value ?? '';
    expect(next).not.toBe(token);
    const tenant = await app.inject({ method: 'GET', url: '/tenant', cookies: { [COOKIE]: next } });
    expect(tenant.json()).toMatchObject({ id: clinic.id });
  });

  it('keeps exactly one hospital active: switching back leaves the first', async () => {
    const token = await signIn(doctor);
    const atClinic = sessionCookie(await switchTo(token, clinic.id))?.value ?? '';

    const atHospital = sessionCookie(await switchTo(atClinic, hospital.id))?.value ?? '';

    expect((await sessionRow(atHospital))?.active_tenant_id).toBe(hospital.id);
    const stale = await app.inject({
      method: 'GET',
      url: '/tenant',
      cookies: { [COOKIE]: atHospital },
      headers: { 'x-tenant-id': clinic.id },
    });
    expect(stale.json().error.code).toBe('tenant_mismatch');
  });

  it('refuses a hospital the user does not belong to, and one that does not exist, alike', async () => {
    const token = await signIn(doctor);
    await switchTo(token, hospital.id);
    const current = (await sessionRow(token))?.active_tenant_id;

    const responses = await Promise.all([
      switchTo(token, elsewhere.id),
      switchTo(token, '00000000-0000-4000-8000-000000000000'),
      switchTo(token, "x' or '1'='1"),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'not_a_member',
        message: responses[0]?.json().error.message,
      });
      expect(response.body).not.toContain('Auth Elsewhere');
    }
    expect((await sessionRow(token))?.active_tenant_id).toBe(current);
  });

  it('needs a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/session/switch-tenant',
      headers: { origin: ORIGIN },
      payload: { tenantId: hospital.id },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('signing out', () => {
  const logout = (token?: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: ORIGIN },
      ...(token ? { cookies: { [COOKIE]: token } } : {}),
    });

  it('ends the session on the server and clears the cookie', async () => {
    const token = await signIn(nurse);

    const response = await logout(token);

    expect(response.statusCode).toBe(204);
    expect(sessionCookie(response)?.value).toBe('');
    expect((await sessionRow(token))?.revoke_reason).toBe('logout');
    expect((await getSession(token)).statusCode).toBe(401);
  });

  it('succeeds when there is nothing to end', async () => {
    expect((await logout()).statusCode).toBe(204);
    expect((await logout('A'.repeat(43))).statusCode).toBe(204);
  });
});

describe('cross-site requests', () => {
  const post = (headers: Record<string, string>, token: string) =>
    app.inject({ method: 'POST', url: '/auth/logout', headers, cookies: { [COOKIE]: token } });

  it('are refused when they would change something, and change nothing', async () => {
    const token = await signIn(nurse);

    const foreign = await post({ origin: 'https://evil.example' }, token);
    const lookalike = await post({ origin: `${ORIGIN}.evil.example` }, token);
    const crossSite = await post({ 'sec-fetch-site': 'cross-site' }, token);
    const sameSite = await post({ 'sec-fetch-site': 'same-site' }, token);

    for (const response of [foreign, lookalike, crossSite, sameSite]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('cross_site_request');
    }
    expect((await getSession(token)).statusCode).toBe(200);
  });

  it('cannot sign anyone in either', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: nurse.email, password: nurse.password },
    });

    expect(response.statusCode).toBe(403);
    expect(sessionCookie(response)).toBeUndefined();
  });

  it('are fine from the web app itself and from non-browser clients', async () => {
    const fromApp = await post({ origin: ORIGIN }, await signIn(nurse));
    const sameOrigin = await post({ 'sec-fetch-site': 'same-origin' }, await signIn(nurse));
    const noHeaders = await post({}, await signIn(nurse));

    for (const response of [fromApp, sameOrigin, noHeaders]) expect(response.statusCode).toBe(204);
  });
});

describe('the cookie in production', () => {
  it('is Secure and locked to this host by its name', async () => {
    const production = await buildTestApp({
      config: { NODE_ENV: 'production', LOG_LEVEL: 'silent' },
    });
    try {
      const response = await production.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: nurse.email, password: nurse.password },
      });

      const cookie = response.cookies.find((item) => item.name === '__Host-mediflow_session');
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect(cookie?.domain).toBeUndefined();
    } finally {
      await production.close();
    }
  });
});

describe('the authentication database role', () => {
  const PERMISSION_DENIED = /permission denied/;

  const asAuth = <T>(userId: string | null, run: (client: pg.PoolClient) => Promise<T>) =>
    withAuthTransaction(pool, async ({ client, identify }) => {
      if (userId) await identify(userId);
      return run(client);
    });

  beforeAll(async () => {
    await pool.query('drop table if exists auth_probe');
    await pool.query(`
      create table auth_probe (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id) on delete cascade,
        note text not null
      )`);
    await pool.query('create index auth_probe_tenant on auth_probe (tenant_id, note)');
    await pool.query("select enable_tenant_rls('auth_probe')");
    await pool.query("insert into auth_probe (tenant_id, note) values ($1, 'patient data')", [
      hospital.id,
    ]);
  });

  afterAll(async () => {
    await pool.query('drop table if exists auth_probe');
  });

  it('cannot read or write a hospital table, even for a member of that hospital', async () => {
    await expect(
      asAuth(nurse.id, (client) => client.query('select * from auth_probe')),
    ).rejects.toThrow(PERMISSION_DENIED);
    await expect(
      asAuth(nurse.id, (client) =>
        client.query("insert into auth_probe (tenant_id, note) values ($1, 'x')", [hospital.id]),
      ),
    ).rejects.toThrow(PERMISSION_DENIED);
  });

  it('sees no hospital and no membership before a user is identified', async () => {
    const seen = await asAuth(null, async (client) => ({
      tenants: (await client.query('select id from tenants')).rowCount,
      features: (await client.query('select 1 from tenant_features')).rowCount,
      memberships: (await client.query('select 1 from memberships')).rowCount,
    }));

    expect(seen).toEqual({ tenants: 0, features: 0, memberships: 0 });
  });

  it("sees only the identified user's hospitals and memberships", async () => {
    const seen = await asAuth(nurse.id, async (client) => ({
      tenants: (await client.query<{ id: string }>('select id from tenants')).rows.map(
        (row) => row.id,
      ),
      members: (
        await client.query<{ user_id: string }>('select distinct user_id from memberships')
      ).rows.map((row) => row.user_id),
    }));

    expect(seen).toEqual({ tenants: [hospital.id], members: [nurse.id] });
  });

  it('cannot rename, promote, re-enable or delete a user, or reach past its grants', async () => {
    const attempts = [
      // A new account is a name and an email. Nothing else can be set, least of all this.
      "insert into users (email, name, is_platform_admin) values ('intruder@staff.test', 'Intruder', true)",
      "insert into users (email, name, status) values ('intruder@staff.test', 'Intruder', 'active')",
      "update users set email = 'taken@staff.test'",
      'update users set is_platform_admin = true',
      "update users set status = 'active'",
      'delete from users',
      "update user_identities set provider = 'oidc'",
      'update user_identities set user_id = app_user_id()',
      'delete from user_identities',
      "update memberships set role_id = 'admin'",
      'delete from memberships',
      'delete from sessions',
      "update tenants set status = 'active'",
      "insert into invites (tenant_id, email, name, role_id, token_hash, expires_at) select id, 'x@staff.test', 'X', 'admin', sha256('x'), now() from tenants",
      "update invites set role_id = 'admin'",
      'update invites set revoked_at = null',
      'delete from invites',
      'delete from password_resets',
    ];

    for (const statement of attempts) {
      await expect(
        asAuth(nurse.id, (client) => client.query(statement)),
        statement,
      ).rejects.toThrow(PERMISSION_DENIED);
    }
  });

  it('cannot put a user into a hospital that has not invited them', async () => {
    await expect(
      asAuth(nurse.id, (client) =>
        client.query(
          "insert into memberships (tenant_id, user_id, role_id) values ($1, app_user_id(), 'admin')",
          [elsewhere.id],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('is not a superuser and cannot bypass row-level security', async () => {
    const { rows } = await pool.query(
      "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'mediflow_auth'",
    );

    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });

  it('leaves identity tables closed to the hospital role', async () => {
    const client = await pool.connect();
    try {
      for (const table of ['users', 'user_identities', 'sessions']) {
        await client.query('begin');
        await client.query('set local role mediflow_app');
        await expect(client.query(`select * from ${table}`), table).rejects.toThrow(
          PERMISSION_DENIED,
        );
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  });
});
