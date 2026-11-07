import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generate } from 'otplib';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMembership,
  buildTestApp,
  createTenant,
  createUser,
  deleteTenants,
  deleteUsers,
  testConfig,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../jobs/queue.js';
import { createMemoryNotifier } from '../notifier/notifier.js';
import { cleanUserAgent } from './sessions.js';

/**
 * The account page's API: changing the password and seeing and ending one's own sessions,
 * through the real app and database.
 */

const COOKIE = 'mediflow_session';
const config = testConfig({ AUTH_RATE_LIMIT_PER_MINUTE: 10_000 });
const ORIGIN = config.APP_BASE_URL;
const NEW_PASSWORD = 'a brand new passphrase';

const notifier = createMemoryNotifier(ORIGIN);
const queue = new MemoryQueue();
let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
const users: TestUser[] = [];
const tenants: TestTenant[] = [];

beforeAll(async () => {
  app = await buildTestApp({
    config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 },
    notifier,
    jobQueue: queue,
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Sessions Hospital');
  tenants.push(hospital);
});

afterAll(async () => {
  await deleteUsers(pool, users);
  await deleteTenants(pool, tenants);
  await app.close();
});

beforeEach(() => {
  notifier.sent.length = 0;
});

async function newUser(name: string) {
  const user = await createUser(pool, name);
  users.push(user);
  await addMembership(pool, user, hospital, 'nurse');
  return user;
}

const request = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token?: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...headers },
    ...(payload ? { payload } : {}),
    ...(token ? { cookies: { [COOKIE]: token } } : {}),
  });

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === COOKIE)?.value;

async function signIn(user: TestUser, userAgent = 'Test Browser/1.0'): Promise<string> {
  const response = await request(
    'POST',
    '/auth/login',
    undefined,
    { email: user.email, password: user.password },
    { 'user-agent': userAgent },
  );
  const token = cookieOf(response);
  if (response.statusCode !== 200 || !token) throw new Error('sign-in failed in test setup');
  return token;
}

const change = (token: string, body: object) =>
  request('POST', '/auth/password/change', token, body);
const errorOf = (response: LightMyRequestResponse) => response.json().error.code as string;
const statusOf = async (token: string) => (await request('GET', '/session', token)).statusCode;

interface Listed {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}
const listed = async (token: string) =>
  (await request('GET', '/auth/sessions', token)).json<{ items: Listed[] }>().items;

describe('changing the password', () => {
  it('changes it, ends the other sessions and keeps the calling one', async () => {
    const user = await newUser('Changing Chandra');
    const here = await signIn(user);
    const elsewhere = await signIn(user);

    const response = await change(here, {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await statusOf(elsewhere)).toBe(401);
    // The calling session carries on, under a new token.
    const rotated = cookieOf(response);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(here);
    expect(await statusOf(rotated!)).toBe(200);
    // The replaced token works for the grace period only.
    expect(await statusOf(here)).toBe(200);
    await pool.query(
      "update sessions set rotated_at = now() - interval '60 seconds' where user_id = $1",
      [user.id],
    );
    expect(await statusOf(here)).toBe(401);

    const old = await request('POST', '/auth/login', undefined, {
      email: user.email,
      password: user.password,
    });
    expect(old.statusCode).toBe(401);
    const fresh = await request('POST', '/auth/login', undefined, {
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('uses up outstanding reset links, writes an account event and emails the user', async () => {
    const user = await newUser('Resetting Reema');
    const session = await signIn(user);
    await pool.query(
      `insert into password_resets (user_id, token_hash, expires_at)
       values ($1, decode(repeat('ab', 32), 'hex'), now() + interval '30 minutes')`,
      [user.id],
    );

    const response = await change(session, {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(204);
    const open = await pool.query(
      'select 1 from password_resets where user_id = $1 and used_at is null',
      [user.id],
    );
    expect(open.rowCount).toBe(0);
    const events = await pool.query(
      'select action, entity, entity_id, request_id from account_events where user_id = $1',
      [user.id],
    );
    expect(events.rows).toEqual([
      expect.objectContaining({ action: 'change_password', entity: 'user', entity_id: user.id }),
    ]);
    expect(events.rows[0].request_id).toBeTruthy();

    await queue.drain();
    const email = notifier.sent.at(-1);
    expect(email?.to).toBe(user.email);
    expect(email?.text).toContain('password');
    expect(email?.text).not.toMatch(/https?:\/\/|token/);
    expect(email?.text).not.toContain(NEW_PASSWORD);
  });

  it('refuses a wrong current password without touching the sign-in lockout', async () => {
    const user = await newUser('Guessing Gita');
    const session = await signIn(user);

    for (let attempt = 1; attempt <= 6; attempt++) {
      const wrong = await change(session, {
        currentPassword: 'wrong wrong wrong',
        newPassword: NEW_PASSWORD,
      });
      // The per-user limit (5 a minute) answers the sixth.
      expect(wrong.statusCode).toBe(attempt <= 5 ? 403 : 429);
    }
    const counted = await pool.query(
      'select failed_login_count, locked_until from users where id = $1',
      [user.id],
    );
    expect(counted.rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
    // The owner still signs in.
    expect((await signInStatus(user.email, user.password)).statusCode).toBe(200);
    const stored = await pool.query(
      "select secret_hash from user_identities where user_id = $1 and provider = 'password'",
      [user.id],
    );
    expect(stored.rows[0].secret_hash).toMatch(/^[$]argon2id/);
  });

  it('limits one session over a quarter of an hour, whatever the per-minute allowance', async () => {
    const user = await newUser('Persistent Pia');
    const session = await signIn(user);
    const body = { currentPassword: 'wrong wrong wrong', newPassword: NEW_PASSWORD };
    const statuses: number[] = [];
    // The per-user window is left out, so only the session limit can answer 429.
    const real = app.rateLimiter.hit.bind(app.rateLimiter);
    const spy = vi
      .spyOn(app.rateLimiter, 'hit')
      .mockImplementation((key, limit, windowMs) =>
        key.startsWith('pwchange:')
          ? Promise.resolve({ allowed: true, retryAfterSeconds: 0 })
          : real(key, limit, windowMs),
      );
    try {
      for (let attempt = 0; attempt < 11; attempt++)
        statuses.push((await change(session, body)).statusCode);
    } finally {
      spy.mockRestore();
    }
    expect(statuses.slice(0, 10).every((status) => status === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  const signInStatus = (email: string, password: string) =>
    request('POST', '/auth/login', undefined, { email, password });

  it.each([
    ['too short', 'short one', 'password_too_short'],
    ['too common', 'password123456', 'password_too_common'],
    ['too long', 'x'.repeat(200) + 'y', 'password_too_long'],
  ])('refuses a new password that is %s', async (_what, newPassword, code) => {
    const user = await newUser('Policy Pooja');
    const session = await signIn(user);

    const response = await change(session, { currentPassword: user.password, newPassword });

    expect([response.statusCode, errorOf(response)]).toEqual([400, code]);
    expect(await statusOf(session)).toBe(200);
    expect((await signInStatus(user.email, user.password)).statusCode).toBe(200);
  });

  it('refuses the same password again, and a password built from the email', async () => {
    const user = await newUser('Same Sana');
    const session = await signIn(user);

    const same = await change(session, {
      currentPassword: user.password,
      newPassword: user.password,
    });
    expect([same.statusCode, errorOf(same)]).toEqual([400, 'password_unchanged']);

    const local = user.email.split('@')[0]!;
    const derived = await change(session, {
      currentPassword: user.password,
      newPassword: `${local}-and-more`,
    });
    expect([derived.statusCode, errorOf(derived)]).toEqual([400, 'password_too_common']);
  });

  it("needs a session, and acts only on the session's own user", async () => {
    const none = await request('POST', '/auth/password/change', undefined, {
      currentPassword: 'a',
      newPassword: 'b',
    });
    expect(none.statusCode).toBe(401);

    const mine = await newUser('Own Omar');
    const theirs = await newUser('Other Oona');
    const session = await signIn(mine);
    // A client-supplied user is ignored: only the session's own password changes.
    await change(session, {
      currentPassword: mine.password,
      newPassword: NEW_PASSWORD,
      userId: theirs.id,
    });
    expect((await signInStatus(theirs.email, theirs.password)).statusCode).toBe(200);
    expect((await signInStatus(mine.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('limits attempts per user before any hashing', async () => {
    const user = await newUser('Limited Lata');
    const session = await signIn(user);
    const body = { currentPassword: 'x', newPassword: 'y' };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++)
      statuses.push((await change(session, body)).statusCode);

    // The first five are answered (a policy refusal comes first; none counts as a password
    // failure here), the sixth is limited.
    expect(statuses.slice(0, 5).every((status) => status === 403 || status === 400)).toBe(true);
    const limited = await change(session, body);
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  describe('with an authenticator', () => {
    async function withAuthenticator(name: string) {
      const user = await newUser(name);
      const session = await signIn(user);
      const enrollment = await request('POST', '/auth/mfa/enroll', session, {
        password: user.password,
      });
      const { secret } = enrollment.json<{ secret: string }>();
      const confirmed = await request('POST', '/auth/mfa/confirm', session, {
        code: await generate({ secret }),
      });
      if (confirmed.statusCode !== 200) throw new Error('could not enable MFA in test setup');
      const next = async () => {
        await pool.query('update user_mfa set last_used_step = null where user_id = $1', [user.id]);
        return generate({ secret });
      };
      return { user, session, next };
    }

    it('asks for a code, refuses a wrong one without counting it toward the lockout', async () => {
      const { user, session, next } = await withAuthenticator('Second Sheela');
      const body = { currentPassword: user.password, newPassword: NEW_PASSWORD };

      const missing = await change(session, body);
      expect([missing.statusCode, errorOf(missing)]).toEqual([400, 'mfa_code_required']);

      const wrong = await change(session, { ...body, code: '000000' });
      expect([wrong.statusCode, errorOf(wrong)]).toEqual([400, 'invalid_mfa_code']);
      const counted = await pool.query('select failed_login_count from users where id = $1', [
        user.id,
      ]);
      expect(counted.rows[0].failed_login_count).toBe(0);

      // A weak new password is not judged for someone who has not proved the second factor.
      const weak = { currentPassword: user.password, newPassword: 'short' };
      const unproven = await change(session, { ...weak, code: '000000' });
      expect([unproven.statusCode, errorOf(unproven)]).toEqual([400, 'invalid_mfa_code']);
      const absent = await change(session, weak);
      expect([absent.statusCode, errorOf(absent)]).toEqual([400, 'mfa_code_required']);

      const right = await change(session, { ...body, code: await next() });
      expect(right.statusCode).toBe(204);
    });
  });
});

describe('listing sessions', () => {
  it("lists the caller's own active sessions, newest first, marking the current one", async () => {
    const user = await newUser('Listing Leela');
    const other = await newUser('Neighbour Nita');
    const first = await signIn(user, 'First Browser');
    const second = await signIn(user, 'Second Browser');
    await signIn(other, 'Not Leela');
    const ended = await signIn(user, 'Ended Browser');
    await request('POST', '/auth/logout', ended);

    const response = await request('GET', '/auth/sessions', second);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ items: Listed[]; nextCursor: null }>();
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.userAgent)).toEqual(['Second Browser', 'First Browser']);
    expect(body.items.map((item) => item.current)).toEqual([true, false]);
    expect(await listed(first)).toHaveLength(2);
  });

  it('never exposes the token or its hash in an id', async () => {
    const user = await newUser('Opaque Om');
    const token = await signIn(user);
    const { rows } = await pool.query<{ id: string; hash: string }>(
      "select id, encode(token_hash, 'hex') as hash from sessions where user_id = $1",
      [user.id],
    );

    const response = await request('GET', '/auth/sessions', token);
    const text = response.body;

    expect(text).not.toContain(token);
    expect(text).not.toContain(rows[0]!.hash);
    expect(text).not.toMatch(/token|hash/i);
    expect(response.json<{ items: Listed[] }>().items[0]?.id).toBe(rows[0]!.id);
  });

  it('cleans and caps the browser description', async () => {
    const user = await newUser('Agent Anu');
    const long = `Mozilla/5.0\t(X11;\r\nLinux)   ${'a'.repeat(400)}`;
    const token = await signIn(user, long.replace(/[\r\n]/g, ' '));

    const [item] = await listed(token);

    expect(item?.userAgent).toMatch(/^Mozilla\/5\.0 \(X11; Linux\) a+$/);
    expect(item?.userAgent?.length).toBe(200);
    expect(cleanUserAgent('\u0000\u0007 \u0085')).toBeNull();
    expect(cleanUserAgent(undefined)).toBeNull();
    expect(cleanUserAgent('Fine\u0007 \u0000Browser')).toBe('Fine Browser');
  });

  it('needs a session', async () => {
    expect((await request('GET', '/auth/sessions')).statusCode).toBe(401);
  });
});

describe('ending a session', () => {
  it('signs the other browser out on its next request', async () => {
    const user = await newUser('Ending Esha');
    const here = await signIn(user);
    const there = await signIn(user, 'Other Browser');
    const target = (await listed(here)).find((item) => !item.current)!;

    const response = await request('DELETE', `/auth/sessions/${target.id}`, here);

    expect(response.statusCode).toBe(204);
    expect(await statusOf(there)).toBe(401);
    expect(await statusOf(here)).toBe(200);
    expect(await listed(here)).toHaveLength(1);
    const events = await pool.query(
      'select action, entity, entity_id from account_events where user_id = $1',
      [user.id],
    );
    expect(events.rows).toEqual([
      { action: 'revoke_session', entity: 'session', entity_id: target.id },
    ]);
    const reason = await pool.query('select revoke_reason from sessions where id = $1', [
      target.id,
    ]);
    expect(reason.rows[0].revoke_reason).toBe('revoked_by_user');
    // Ending it again is the same answer as an unknown id.
    expect((await request('DELETE', `/auth/sessions/${target.id}`, here)).statusCode).toBe(404);
  });

  it('refuses the calling session with 409', async () => {
    const user = await newUser('Current Chitra');
    const here = await signIn(user);
    const current = (await listed(here)).find((item) => item.current)!;

    const response = await request('DELETE', `/auth/sessions/${current.id}`, here);

    expect([response.statusCode, errorOf(response)]).toEqual([409, 'current_session']);
    expect(await statusOf(here)).toBe(200);
  });

  it("answers another user's session, an unknown one and a malformed id identically", async () => {
    const mine = await newUser('Mine Meena');
    const theirs = await newUser('Theirs Tara');
    const here = await signIn(mine);
    const theirToken = await signIn(theirs);
    const theirId = (await listed(theirToken))[0]!.id;

    const answers = await Promise.all(
      [theirId, '00000000-0000-4000-8000-000000000000', 'not-a-uuid', theirId.toUpperCase()].map(
        async (id) => {
          const response = await request('DELETE', `/auth/sessions/${id}`, here);
          const body = response.json().error;
          return [response.statusCode, body.code, body.message];
        },
      ),
    );

    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual([404, 'not_found', 'No such session']);
    // Nothing happened to the other user's session.
    expect(await statusOf(theirToken)).toBe(200);
    expect(await listed(theirToken)).toHaveLength(1);
    expect((await listed(here)).every((item) => item.id !== theirId)).toBe(true);
  });

  it('needs a session', async () => {
    const response = await request('DELETE', '/auth/sessions/00000000-0000-4000-8000-000000000000');
    expect(response.statusCode).toBe(401);
  });
});

describe('account events', () => {
  it('are append-only and visible to their own user only', async () => {
    const user = await newUser('Trail Tanvi');
    const other = await newUser('Trail Tej');
    await change(await signIn(user), { currentPassword: user.password, newPassword: NEW_PASSWORD });

    await expect(pool.query('update account_events set action = $1', ['x'])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      pool.query('delete from account_events where user_id = $1', [user.id]),
    ).rejects.toThrow(/append-only/);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_auth');
      await client.query("select set_config('app.user_id', $1, true)", [other.id]);
      const seen = await client.query('select 1 from account_events where user_id = $1', [user.id]);
      expect(seen.rowCount).toBe(0);
      await expect(
        client.query(
          "insert into account_events (user_id, action, entity) values ($1, 'x', 'user')",
          [user.id],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('before an authenticator is set up', () => {
  it('stays within reach of a user whom the hospital holds back', async () => {
    const strict = await createTenant(pool, 'Strict Sessions Hospital', {
      features: { mfa: true, mfa_required: true },
    });
    tenants.push(strict);
    const user = await createUser(pool, 'Pending Parul');
    users.push(user);
    await addMembership(pool, user, strict, 'nurse');
    const session = await signIn(user);
    const held = await request('GET', '/tenant', session);
    expect([held.statusCode, errorOf(held)]).toEqual([403, 'mfa_required']);

    expect((await request('GET', '/auth/sessions', session)).statusCode).toBe(200);
    const other = await signIn(user);
    const target = (await listed(session)).find((item) => !item.current)!;
    expect((await request('DELETE', `/auth/sessions/${target.id}`, session)).statusCode).toBe(204);
    expect(await statusOf(other)).toBe(401);
    const changed = await change(session, {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.statusCode).toBe(204);
  });
});
