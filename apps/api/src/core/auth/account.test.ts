import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generate } from 'otplib';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createMemoryNotifier } from '../notifier/notifier.js';
import { APP_ROLE } from '../tenancy/plugin.js';
import { withAuthTransaction } from './db.js';
import { issueInvite, sendInvite, type IssuedInvite } from './invites.js';
import { decryptSecret, encryptSecret } from './mfa.js';
import { hashToken } from './sessions.js';

/**
 * Invites, password reset and the second factor, through the real app and database. Email goes
 * to an in-memory notifier, so links are read from what would have been sent.
 */

const COOKIE = 'mediflow_session';
const config = testConfig({ AUTH_RATE_LIMIT_PER_MINUTE: 10_000 });
const ORIGIN = config.APP_BASE_URL;
const NEW_PASSWORD = 'a brand new passphrase';
const RLS_VIOLATION = /row-level security policy/;

const notifier = createMemoryNotifier(ORIGIN);
let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
const users: TestUser[] = [];

beforeAll(async () => {
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 }, notifier });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Account Hospital');
  clinic = await createTenant(pool, 'Account Clinic');
  admin = await newUser('Admin Asha');
  await addMembership(pool, admin, hospital, 'admin');
});

afterAll(async () => {
  await pool.query("delete from users where email like '%@invited.test'");
  await deleteUsers(pool, users);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

beforeEach(() => {
  notifier.sent.length = 0;
});

async function newUser(name: string, overrides: Parameters<typeof createUser>[2] = {}) {
  const user = await createUser(pool, name, overrides);
  users.push(user);
  return user;
}

const post = (url: string, payload: object, token?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN },
    payload,
    ...(token ? { cookies: { [COOKIE]: token } } : {}),
  });

const login = (email: string, password: string, code?: string) =>
  post('/auth/login', { email, password, ...(code ? { code } : {}) });

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === COOKIE)?.value;

async function signIn(user: TestUser, code?: string): Promise<string> {
  const response = await login(user.email, user.password, code);
  const token = cookieOf(response);
  if (response.statusCode !== 200 || !token) throw new Error('sign-in failed in test setup');
  return token;
}

const errorOf = (response: LightMyRequestResponse) => response.json().error.code as string;

/** The token in the link of the last email sent. */
function emailedToken(): string {
  const email = notifier.sent.at(-1);
  const token = email?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error('no link was emailed');
  return token;
}

/** Runs as a request of that hospital would: the app role with the tenant set. Committed. */
async function inTenant<T>(tenant: TestTenant, run: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenant.id]);
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

let invitee = 0;
const freshEmail = () => `invitee.${Date.now()}.${invitee++}@invited.test`;

/** What a hospital admin does: invite, then send the email once the invite is committed. */
async function invite(
  tenant: TestTenant,
  email: string,
  roleId = 'nurse',
  name = 'Invited Ira',
): Promise<IssuedInvite> {
  const issued = await inTenant(tenant, (client) =>
    issueInvite(client, config, { email, name, roleId, invitedBy: admin.id }),
  );
  await sendInvite(notifier, issued);
  return issued;
}

describe('inviting someone', () => {
  it('emails one link and stores only a hash of its token', async () => {
    const email = freshEmail();

    const issued = await invite(hospital, email);

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ to: email, template: 'invite' });
    expect(notifier.sent[0]?.text).toContain('Account Hospital');
    expect(emailedToken()).toBe(issued.token);
    const { rows } = await pool.query<{ token_hash: Buffer; hours: number }>(
      'select token_hash, round(extract(epoch from expires_at - created_at) / 3600) as hours from invites where id = $1',
      [issued.id],
    );
    expect(rows[0]?.token_hash.equals(hashToken(issued.token))).toBe(true);
    expect(Number(rows[0]?.hours)).toBe(168);
  });

  it('shows the invited person which hospital and address it is for', async () => {
    const email = freshEmail();
    const { token } = await invite(hospital, email.toUpperCase());

    const response = await post('/auth/invite/inspect', { token });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email,
      hospitalName: 'Account Hospital',
      needsPassword: true,
    });
  });

  it('gives a new person an account, a password and the invited role', async () => {
    const email = freshEmail();
    const { token } = await invite(hospital, email, 'pharmacist', 'Pharmacist Pia');

    const response = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });

    expect(response.statusCode).toBe(204);
    const session = await login(email, NEW_PASSWORD);
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      user: {
        email,
        name: 'Pharmacist Pia',
        memberships: [{ tenantId: hospital.id, roleId: 'pharmacist' }],
      },
      activeTenant: { id: hospital.id },
    });
  });

  it('works once', async () => {
    const { token } = await invite(hospital, freshEmail());
    await post('/auth/invite/accept', { token, password: NEW_PASSWORD });

    const again = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });
    const preview = await post('/auth/invite/inspect', { token });

    expect([again.statusCode, errorOf(again)]).toEqual([400, 'invalid_token']);
    expect([preview.statusCode, errorOf(preview)]).toEqual([400, 'invalid_token']);
  });

  it('enforces the password rule, and a refused password does not use up the link', async () => {
    const email = freshEmail();
    const { token } = await invite(hospital, email);

    const none = await post('/auth/invite/accept', { token });
    const short = await post('/auth/invite/accept', { token, password: 'elevenchars' });
    const common = await post('/auth/invite/accept', { token, password: 'password-password' });
    const own = await post('/auth/invite/accept', {
      token,
      password: `${email.split('@')[0]}!`,
    });

    expect(errorOf(none)).toBe('password_required');
    expect(errorOf(short)).toBe('password_too_short');
    expect(errorOf(common)).toBe('password_too_common');
    expect(errorOf(own)).toBe('password_too_common');
    for (const response of [none, short, common, own]) expect(response.statusCode).toBe(400);
    expect((await pool.query('select 1 from users where email = $1', [email])).rowCount).toBe(0);

    expect((await post('/auth/invite/accept', { token, password: NEW_PASSWORD })).statusCode).toBe(
      204,
    );
  });

  it('adds a hospital to someone who already has an account, keeping their password', async () => {
    const doctor = await newUser('Doctor Dia');
    await addMembership(pool, doctor, hospital, 'doctor');
    const { token } = await invite(clinic, doctor.email, 'doctor');

    const preview = await post('/auth/invite/inspect', { token });
    // A password sent anyway is ignored: the link does not let anyone change it.
    const response = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });

    expect(preview.json()).toMatchObject({ hospitalName: 'Account Clinic', needsPassword: false });
    expect(response.statusCode).toBe(204);
    expect((await login(doctor.email, NEW_PASSWORD)).statusCode).toBe(401);
    const session = await login(doctor.email, doctor.password);
    expect(session.json().user.memberships).toEqual([
      { tenantId: clinic.id, tenantName: 'Account Clinic', roleId: 'doctor' },
      { tenantId: hospital.id, tenantName: 'Account Hospital', roleId: 'doctor' },
    ]);
  });

  it('expires', async () => {
    const { id, token } = await invite(hospital, freshEmail());
    await pool.query("update invites set expires_at = now() - interval '1 second' where id = $1", [
      id,
    ]);

    const response = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });

    expect([response.statusCode, errorOf(response)]).toEqual([400, 'invalid_token']);
  });

  it('is replaced by a newer invite to the same address', async () => {
    const email = freshEmail();
    const first = await invite(hospital, email, 'nurse');
    const second = await invite(hospital, email, 'receptionist');

    const old = await post('/auth/invite/accept', { token: first.token, password: NEW_PASSWORD });
    const current = await post('/auth/invite/accept', {
      token: second.token,
      password: NEW_PASSWORD,
    });

    expect(errorOf(old)).toBe('invalid_token');
    expect(current.statusCode).toBe(204);
    expect((await login(email, NEW_PASSWORD)).json().user.memberships).toMatchObject([
      { roleId: 'receptionist' },
    ]);
  });

  it('answers a made-up link exactly as an expired one', async () => {
    const { id, token } = await invite(hospital, freshEmail());
    await pool.query("update invites set expires_at = now() - interval '1 second' where id = $1", [
      id,
    ]);

    const expired = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });
    const forged = await post('/auth/invite/accept', {
      token: 'A'.repeat(43),
      password: NEW_PASSWORD,
    });
    const malformed = await post('/auth/invite/inspect', { token: "' or 1=1 --" });

    for (const response of [forged, malformed]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: 'invalid_token',
        message: expired.json().error.message,
      });
    }
  });

  it('does not reopen a disabled account', async () => {
    const leaver = await newUser('Leaver Lal', { status: 'disabled' });
    const { token } = await invite(hospital, leaver.email);

    const response = await post('/auth/invite/accept', { token, password: NEW_PASSWORD });

    expect(errorOf(response)).toBe('invalid_token');
  });
});

describe('invites and tenant isolation', () => {
  it('belong to the hospital whose transaction created them, whatever the code asks for', async () => {
    const email = freshEmail();
    const issued = await invite(hospital, email);

    const { rows } = await pool.query<{ tenant_id: string }>(
      'select tenant_id from invites where id = $1',
      [issued.id],
    );
    expect(rows[0]?.tenant_id).toBe(hospital.id);
    await expect(
      inTenant(hospital, (client) =>
        client.query(
          `insert into invites (tenant_id, email, name, role_id, token_hash, expires_at)
           values ($1, $2, 'X', 'admin', $3, now() + interval '1 day')`,
          [clinic.id, freshEmail(), hashToken('B'.repeat(43))],
        ),
      ),
    ).rejects.toThrow(RLS_VIOLATION);
  });

  it('are invisible to another hospital, which cannot withdraw them either', async () => {
    const email = freshEmail();
    const atHospital = await invite(hospital, email, 'nurse');

    const seen = await inTenant(clinic, async (client) => ({
      rows: (await client.query('select 1 from invites where email = $1', [email])).rowCount,
      revoked: (
        await client.query('update invites set revoked_at = now() where email = $1', [email])
      ).rowCount,
    }));
    // The clinic inviting the same person does not disturb the hospital's invite.
    const atClinic = await invite(clinic, email, 'doctor');

    expect(seen).toEqual({ rows: 0, revoked: 0 });
    expect((await post('/auth/invite/inspect', { token: atHospital.token })).json()).toMatchObject({
      hospitalName: 'Account Hospital',
    });
    expect((await post('/auth/invite/inspect', { token: atClinic.token })).json()).toMatchObject({
      hospitalName: 'Account Clinic',
    });
  });

  it('are the only way into a hospital: the database refuses a membership without one', async () => {
    const outsider = await newUser('Outsider Om');
    await invite(hospital, outsider.email, 'nurse');
    const join = (tenant: TestTenant, roleId: string) =>
      withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(outsider.id);
        await client.query(
          'insert into memberships (tenant_id, user_id, role_id) values ($1, $2, $3)',
          [tenant.id, outsider.id, roleId],
        );
      });

    // Not invited there.
    await expect(join(clinic, 'nurse')).rejects.toThrow(RLS_VIOLATION);
    // Invited, but not as an admin.
    await expect(join(hospital, 'admin')).rejects.toThrow(RLS_VIOLATION);
    // Someone else cannot use this person's invite.
    await expect(
      withAuthTransaction(pool, async ({ client, identify }) => {
        await identify(admin.id);
        await client.query(
          "insert into memberships (tenant_id, user_id, role_id) values ($1, $2, 'nurse')",
          [hospital.id, outsider.id],
        );
      }),
    ).rejects.toThrow(RLS_VIOLATION);
    expect(
      (await pool.query('select 1 from memberships where user_id = $1', [outsider.id])).rowCount,
    ).toBe(0);
  });
});

describe('forgetting a password', () => {
  const forgot = (email: string) => post('/auth/password/forgot', { email });

  it('emails a link, and answers the same whether or not the account exists', async () => {
    const user = await newUser('Forgetful Fia');
    const sso = await newUser('Sso Sam', { withPassword: false });
    const gone = await newUser('Gone Gul', { status: 'disabled' });

    const known = await forgot(`  ${user.email.toUpperCase()}`);
    const others = await Promise.all([
      forgot('nobody.at.all@staff.test'),
      forgot(sso.email),
      forgot(gone.email),
    ]);

    expect(known.statusCode).toBe(204);
    for (const response of others) {
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe(known.body);
    }
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ to: user.email, template: 'password_reset' });
    expect(notifier.sent[0]?.text).toContain('expires in 30 minutes');
  });

  it('cannot be used to flood an inbox', async () => {
    const user = await newUser('Flooded Fen');

    await forgot(user.email);
    await forgot(user.email);
    await forgot(user.email);

    expect(notifier.sent).toHaveLength(1);
  });

  it('still answers when the email cannot be sent', async () => {
    const user = await newUser('Unlucky Uma');
    const send = notifier.send;
    notifier.send = () => Promise.reject(new Error('mail server down'));
    try {
      expect((await forgot(user.email)).statusCode).toBe(204);
    } finally {
      notifier.send = send;
    }
  });
});

describe('resetting a password', () => {
  async function resetLink(user: TestUser): Promise<string> {
    // Past the one-a-minute limit, so each call sends a new link.
    await pool.query(
      "update password_resets set created_at = created_at - interval '2 minutes' where user_id = $1",
      [user.id],
    );
    await post('/auth/password/forgot', { email: user.email });
    return emailedToken();
  }
  const reset = (token: string, password: string) =>
    post('/auth/password/reset', { token, password });

  it('sets the new password and ends every session of the user', async () => {
    const user = await newUser('Resetting Ria');
    await addMembership(pool, user, hospital);
    const laptop = await signIn(user);
    const phone = await signIn(user);
    const token = await resetLink(user);

    const response = await reset(token, NEW_PASSWORD);

    expect(response.statusCode).toBe(204);
    expect((await login(user.email, user.password)).statusCode).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
    for (const session of [laptop, phone]) {
      const check = await app.inject({ url: '/session', cookies: { [COOKIE]: session } });
      expect(check.statusCode).toBe(401);
    }
    const { rows } = await pool.query<{ revoke_reason: string }>(
      'select distinct revoke_reason from sessions where user_id = $1 and token_hash = any($2)',
      [user.id, [hashToken(laptop), hashToken(phone)]],
    );
    expect(rows).toEqual([{ revoke_reason: 'password_changed' }]);
  });

  it('stores a hash of the link and of the password, never either one', async () => {
    const user = await newUser('Hashed Hari');
    const token = await resetLink(user);
    await reset(token, NEW_PASSWORD);

    const { rows } = await pool.query<{ token_hash: Buffer; secret_hash: string }>(
      `select r.token_hash, p.secret_hash from password_resets r
       join user_identities p on p.user_id = r.user_id where r.user_id = $1`,
      [user.id],
    );
    expect(rows[0]?.token_hash.equals(hashToken(token))).toBe(true);
    expect(rows[0]?.secret_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.secret_hash).not.toContain(NEW_PASSWORD);
  });

  it('works once', async () => {
    const user = await newUser('Once Oni');
    const token = await resetLink(user);
    await reset(token, NEW_PASSWORD);

    const again = await reset(token, 'another fine passphrase');

    expect([again.statusCode, errorOf(again)]).toEqual([400, 'invalid_token']);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('enforces the password rule without using up the link', async () => {
    const user = await newUser('Careless Kai');
    const token = await resetLink(user);

    const short = await reset(token, 'elevenchars');
    const common = await reset(token, 'qwertyuiopasdf');

    expect([short.statusCode, errorOf(short)]).toEqual([400, 'password_too_short']);
    expect([common.statusCode, errorOf(common)]).toEqual([400, 'password_too_common']);
    expect((await login(user.email, user.password)).statusCode).toBe(200);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('expires, and a newer link replaces an older one', async () => {
    const user = await newUser('Late Lila');
    const first = await resetLink(user);
    const second = await resetLink(user);
    expect(errorOf(await reset(first, NEW_PASSWORD))).toBe('invalid_token');

    await pool.query(
      "update password_resets set expires_at = now() - interval '1 second' where user_id = $1",
      [user.id],
    );

    expect(errorOf(await reset(second, NEW_PASSWORD))).toBe('invalid_token');
    expect(errorOf(await reset('A'.repeat(43), NEW_PASSWORD))).toBe('invalid_token');
    expect((await login(user.email, user.password)).statusCode).toBe(200);
  });

  it('lifts a lockout', async () => {
    const user = await newUser('Locked Lex');
    for (let attempt = 1; attempt <= 5; attempt++) await login(user.email, 'wrong password here');
    expect((await login(user.email, user.password)).statusCode).toBe(401);

    await reset(await resetLink(user), NEW_PASSWORD);

    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });
});

describe('the second factor', () => {
  /** The user's authenticator app: knows the secret and makes the current code. */
  interface Authenticator {
    secret: string;
    recoveryCodes: string[];
    /** The current code. Forgets that earlier codes were used, so tests need not wait 30 s. */
    code(): Promise<string>;
  }

  async function freshCode(user: TestUser, secret: string): Promise<string> {
    await pool.query('update user_mfa set last_used_step = null where user_id = $1', [user.id]);
    return generate({ secret });
  }

  async function enableMfa(user: TestUser): Promise<Authenticator> {
    const session = await signIn(user);
    const enrollment = await post('/auth/mfa/enroll', { password: user.password }, session);
    const { secret } = enrollment.json<{ secret: string }>();
    const confirmed = await post(
      '/auth/mfa/confirm',
      { code: await generate({ secret }) },
      session,
    );
    if (confirmed.statusCode !== 200) throw new Error('could not enable MFA in test setup');
    return {
      secret,
      recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes,
      code: () => freshCode(user, secret),
    };
  }

  const sessionOf = async (token: string) =>
    (await app.inject({ url: '/session', cookies: { [COOKIE]: token } })).json();

  it('is set up in two steps, and changes nothing until the second', async () => {
    const user = await newUser('Careful Cara');
    const session = await signIn(user);

    const enrollment = await post('/auth/mfa/enroll', { password: user.password }, session);

    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.headers['cache-control']).toBe('no-store');
    const { secret, otpauthUri } = enrollment.json<{ secret: string; otpauthUri: string }>();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(otpauthUri).toBe(
      `otpauth://totp/Mediflow:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Mediflow`,
    );
    expect((await sessionOf(session)).user.mfaEnabled).toBe(false);
    expect((await login(user.email, user.password)).statusCode).toBe(200);

    const wrong = await post('/auth/mfa/confirm', { code: '000000' }, session);
    expect([wrong.statusCode, errorOf(wrong)]).toEqual([400, 'invalid_mfa_code']);
    expect((await sessionOf(session)).user.mfaEnabled).toBe(false);

    const confirmed = await post(
      '/auth/mfa/confirm',
      { code: await generate({ secret }) },
      session,
    );
    expect(confirmed.statusCode).toBe(200);
    const { recoveryCodes } = confirmed.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect((await sessionOf(session)).user.mfaEnabled).toBe(true);
  });

  it('needs the password to set up, so a borrowed session cannot lock the owner out', async () => {
    const user = await newUser('Borrowed Bea');
    const session = await signIn(user);

    const response = await post(
      '/auth/mfa/enroll',
      { password: 'not the right password' },
      session,
    );

    expect([response.statusCode, errorOf(response)]).toEqual([403, 'invalid_password']);
    expect(
      (await pool.query('select 1 from user_mfa where user_id = $1', [user.id])).rowCount,
    ).toBe(0);
  });

  it('is then asked for at sign-in, after the password', async () => {
    const user = await newUser('Second Sita');
    const authenticator = await enableMfa(user);

    const noCode = await login(user.email, user.password);
    const wrongCode = await login(user.email, user.password, '000000');
    const wrongPassword = await login(
      user.email,
      'wrong password here',
      await authenticator.code(),
    );
    const right = await login(user.email, user.password, await authenticator.code());

    expect([noCode.statusCode, errorOf(noCode)]).toEqual([401, 'mfa_required']);
    expect([wrongCode.statusCode, errorOf(wrongCode)]).toEqual([401, 'invalid_mfa_code']);
    // A wrong password never learns that a code would have been needed.
    expect([wrongPassword.statusCode, errorOf(wrongPassword)]).toEqual([
      401,
      'invalid_credentials',
    ]);
    for (const response of [noCode, wrongCode, wrongPassword]) {
      expect(cookieOf(response)).toBeUndefined();
    }
    expect(right.statusCode).toBe(200);
    expect(right.json().user.mfaEnabled).toBe(true);
  });

  it('accepts a code once: the same code again is refused', async () => {
    const user = await newUser('Replayed Ravi');
    const authenticator = await enableMfa(user);
    const code = await authenticator.code();

    const first = await login(user.email, user.password, code);
    const replay = await login(user.email, user.password, code);

    expect(first.statusCode).toBe(200);
    expect([replay.statusCode, errorOf(replay)]).toEqual([401, 'invalid_mfa_code']);
  });

  it('counts wrong codes toward the lockout, like wrong passwords', async () => {
    const user = await newUser('Guessed Gita');
    const authenticator = await enableMfa(user);

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(errorOf(await login(user.email, user.password, '000000'))).toBe('invalid_mfa_code');
    }
    // Asking which factor is needed is not a guess and was not counted above.
    const locked = await login(user.email, user.password, await authenticator.code());

    expect([locked.statusCode, errorOf(locked)]).toEqual([401, 'invalid_credentials']);
  });

  it('does not count being asked for the code as a failure', async () => {
    const user = await newUser('Patient Pal');
    const authenticator = await enableMfa(user);

    for (let attempt = 1; attempt <= 6; attempt++) await login(user.email, user.password);

    expect((await login(user.email, user.password, await authenticator.code())).statusCode).toBe(
      200,
    );
  });

  it('takes a recovery code instead, once, however it is typed', async () => {
    const user = await newUser('Lost Phone Lena');
    const { recoveryCodes } = await enableMfa(user);
    const [first = '', second = ''] = recoveryCodes;

    const used = await login(user.email, user.password, first);
    const again = await login(user.email, user.password, first);
    const typed = await login(
      user.email,
      user.password,
      ` ${second.toUpperCase().replace('-', ' ')} `,
    );
    const madeUp = await login(user.email, user.password, 'aaaaa-bbbbb');

    expect(used.statusCode).toBe(200);
    expect(errorOf(again)).toBe('invalid_mfa_code');
    expect(typed.statusCode).toBe(200);
    expect(errorOf(madeUp)).toBe('invalid_mfa_code');
  });

  it('replaces recovery codes on request, with the password and a real code', async () => {
    const user = await newUser('Renewing Rani');
    const authenticator = await enableMfa(user);
    const session = await signIn(user, await authenticator.code());
    const renew = async (password: string, code: string) =>
      post('/auth/mfa/recovery-codes', { password, code }, session);

    const withRecoveryCode = await renew(user.password, authenticator.recoveryCodes[0] ?? '');
    const wrongPassword = await renew('not the right password', await authenticator.code());
    const renewed = await renew(user.password, await authenticator.code());

    expect([withRecoveryCode.statusCode, errorOf(withRecoveryCode)]).toEqual([
      400,
      'invalid_mfa_code',
    ]);
    expect([wrongPassword.statusCode, errorOf(wrongPassword)]).toEqual([403, 'invalid_password']);
    expect(renewed.statusCode).toBe(200);
    const fresh = renewed.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(errorOf(await login(user.email, user.password, authenticator.recoveryCodes[1]))).toBe(
      'invalid_mfa_code',
    );
    expect((await login(user.email, user.password, fresh[0])).statusCode).toBe(200);
  });

  it('cannot be set up twice, and is removed only with the password and a code', async () => {
    const user = await newUser('Leaving Mfa Lou');
    const authenticator = await enableMfa(user);
    const session = await signIn(user, await authenticator.code());

    const twice = await post('/auth/mfa/enroll', { password: user.password }, session);
    const noCode = await post(
      '/auth/mfa/disable',
      { password: user.password, code: '000000' },
      session,
    );
    const noPassword = await post(
      '/auth/mfa/disable',
      { password: 'not the right password', code: await authenticator.code() },
      session,
    );
    expect([twice.statusCode, errorOf(twice)]).toEqual([409, 'mfa_already_enabled']);
    expect([noCode.statusCode, errorOf(noCode)]).toEqual([400, 'invalid_mfa_code']);
    expect([noPassword.statusCode, errorOf(noPassword)]).toEqual([403, 'invalid_password']);
    expect((await sessionOf(session)).user.mfaEnabled).toBe(true);

    const removed = await post(
      '/auth/mfa/disable',
      { password: user.password, code: await authenticator.code() },
      session,
    );

    expect(removed.statusCode).toBe(204);
    expect((await sessionOf(session)).user.mfaEnabled).toBe(false);
    expect((await login(user.email, user.password)).statusCode).toBe(200);
    expect(
      (await pool.query('select 1 from mfa_recovery_codes where user_id = $1', [user.id])).rowCount,
    ).toBe(0);
  });

  it('survives a password reset: the mailbox alone is not enough to sign in', async () => {
    const user = await newUser('Phished Pari');
    const authenticator = await enableMfa(user);
    await post('/auth/password/forgot', { email: user.email });

    await post('/auth/password/reset', { token: emailedToken(), password: NEW_PASSWORD });

    expect(errorOf(await login(user.email, NEW_PASSWORD))).toBe('mfa_required');
    expect((await login(user.email, NEW_PASSWORD, await authenticator.code())).statusCode).toBe(
      200,
    );
  });

  it('needs a session for every change', async () => {
    for (const [url, payload] of [
      ['/auth/mfa/enroll', { password: TEST_PASSWORD }],
      ['/auth/mfa/confirm', { code: '123456' }],
      ['/auth/mfa/recovery-codes', { password: TEST_PASSWORD, code: '123456' }],
      ['/auth/mfa/disable', { password: TEST_PASSWORD, code: '123456' }],
    ] as const) {
      const response = await post(url, payload);
      expect([url, response.statusCode]).toEqual([url, 401]);
    }
  });

  it('keeps the secret encrypted, bound to its user, and unreadable to anyone else', async () => {
    const user = await newUser('Secret Sara');
    const other = await newUser('Other Omar');
    const { secret } = await enableMfa(user);

    const { rows } = await pool.query<{ secret_encrypted: Buffer }>(
      'select secret_encrypted from user_mfa where user_id = $1',
      [user.id],
    );
    const stored = rows[0]?.secret_encrypted ?? Buffer.alloc(0);
    expect(stored.includes(Buffer.from(secret))).toBe(false);
    expect(decryptSecret(config, user.id, stored)).toBe(secret);
    // Copied onto another user's row, or altered, it does not decrypt.
    expect(() => decryptSecret(config, other.id, stored)).toThrow();
    const altered = Buffer.from(stored);
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
    expect(() => decryptSecret(config, user.id, altered)).toThrow();
    // Another key does not open it, and no two encryptions look alike.
    const otherKey = { MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect(() => decryptSecret(otherKey, user.id, stored)).toThrow();
    expect(encryptSecret(config, user.id, secret).equals(stored)).toBe(false);

    const seen = await withAuthTransaction(pool, async ({ client, identify }) => {
      await identify(other.id);
      return {
        secrets: (await client.query('select 1 from user_mfa')).rowCount,
        codes: (await client.query('select 1 from mfa_recovery_codes')).rowCount,
        removed: (await client.query('delete from user_mfa')).rowCount,
      };
    });
    expect(seen).toEqual({ secrets: 0, codes: 0, removed: 0 });
  });
});
