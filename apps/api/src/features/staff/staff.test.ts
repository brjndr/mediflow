import { randomUUID } from 'node:crypto';
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
import { createMemoryNotifier } from '../../core/notifier/notifier.js';

/**
 * Staff management through the real app and database, signed in by cookie: the list, the roles
 * someone may be invited into, deactivating and reactivating, ending sessions, withdrawing an
 * invitation, the ceiling on all of it, and the hospital boundary.
 */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;
const notifier = createMemoryNotifier(ORIGIN);

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let nurse: TestUser;
/** A doctor at both hospitals. */
let doctor: TestUser;
/** In a role the hospital made for its HR desk: all three staff permissions and nothing else. */
let hr: TestUser;
let hrColleague: TestUser;
/** The clinic's two administrators. */
let clinicAdmin: TestUser;
let clinicAdminTwo: TestUser;
const users: TestUser[] = [];

interface Person {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  status: string;
}
interface Page {
  items: Person[];
  nextCursor: string | null;
  total?: number;
}

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

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, cookies: { [COOKIE]: token } });
const send = (method: 'POST' | 'DELETE', url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    cookies: { [COOKIE]: token },
    headers: { origin: ORIGIN },
    ...(payload ? { payload } : {}),
  });
const act = (
  user: TestUser,
  action: 'deactivate' | 'reactivate' | 'revoke-sessions',
  token: string,
) => send('POST', `/staff/${user.id}/${action}`, token);
const errorOf = (response: LightMyRequestResponse) =>
  [response.statusCode, response.json().error.code] as const;
const names = (response: LightMyRequestResponse) =>
  response.json<Page>().items.map((item) => item.name);

let invitee = 0;
const freshEmail = () => `invitee.${Date.now()}.${invitee++}@staff-invited.test`;

/** Invites someone and returns the invitation's id and the token in the emailed link. */
async function invite(token: string, roleId = 'nurse') {
  notifier.sent.length = 0;
  const email = freshEmail();
  const response = await send('POST', '/invites', token, { email, name: 'Invited Ira', roleId });
  if (response.statusCode !== 201) throw new Error('invite failed in test setup');
  const link = notifier.sent.at(-1)?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? '';
  return { id: response.json<{ id: string }>().id, email, link };
}

const statusOf = async (user: TestUser, tenant: TestTenant) =>
  (
    await pool.query<{ status: string }>(
      'select status from memberships where user_id = $1 and tenant_id = $2',
      [user.id, tenant.id],
    )
  ).rows[0]?.status;

const cutOffOf = async (user: TestUser, tenant: TestTenant) =>
  (
    await pool.query<{ sessions_valid_after: Date | null }>(
      'select sessions_valid_after from memberships where user_id = $1 and tenant_id = $2',
      [user.id, tenant.id],
    )
  ).rows[0]?.sessions_valid_after ?? null;

const audited = async (tenant: TestTenant, entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [tenant.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

async function newUser(name: string) {
  const user = await createUser(pool, name);
  users.push(user);
  return user;
}

beforeAll(async () => {
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 }, notifier });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Staff Hospital');
  clinic = await createTenant(pool, 'Staff Clinic');
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  await pool.query("insert into roles (tenant_id, id, name) values ($1, 'hr_desk', 'HR desk')", [
    hospital.id,
  ]);
  await pool.query(
    `insert into role_permissions (tenant_id, role_id, permission) values
       ($1, 'hr_desk', 'staff:read'), ($1, 'hr_desk', 'staff:invite'), ($1, 'hr_desk', 'staff:manage')`,
    [hospital.id],
  );
  admin = await newUser('Staff Admin');
  nurse = await newUser('Nurse Nila');
  doctor = await newUser('Doctor Dev');
  hr = await newUser('HR Hema');
  hrColleague = await newUser('HR Hari');
  clinicAdmin = await newUser('Clinic Admin One');
  clinicAdminTwo = await newUser('Clinic Admin Two');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, hr, hospital, 'hr_desk');
  await addMembership(pool, hrColleague, hospital, 'hr_desk');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, clinicAdminTwo, clinic, 'admin');
});

afterAll(async () => {
  await pool.query("delete from invites where email like '%@staff-invited.test'");
  await deleteUsers(pool, users);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

beforeEach(async () => {
  notifier.sent.length = 0;
  // Every test starts from everyone active.
  await pool.query(
    "update memberships set status = 'active', sessions_valid_after = null where tenant_id = any($1)",
    [[hospital.id, clinic.id]],
  );
});

describe('the staff list', () => {
  it('lists the hospital’s active members by name, with their role', async () => {
    const response = await get('/staff', await signIn(admin));

    expect(response.statusCode).toBe(200);
    const page = response.json<Page>();
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.name)).toEqual([
      'Doctor Dev',
      'HR Hari',
      'HR Hema',
      'Nurse Nila',
      'Staff Admin',
    ]);
    expect(page.items[3]).toEqual({
      id: nurse.id,
      tenantId: hospital.id,
      name: 'Nurse Nila',
      email: nurse.email,
      roleId: 'nurse',
      roleName: 'Nurse',
      status: 'active',
    });
  });

  it('pages by cursor and searches the name and the address', async () => {
    const token = await signIn(admin);

    const first = await get('/staff?limit=2', token);
    const cursor = first.json<Page>().nextCursor ?? '';
    const second = await get(`/staff?limit=2&cursor=${encodeURIComponent(cursor)}`, token);
    expect(names(first)).toEqual(['Doctor Dev', 'HR Hari']);
    expect(names(second)).toEqual(['HR Hema', 'Nurse Nila']);
    expect(second.json<Page>().total).toBeUndefined();

    expect(names(await get('/staff?q=hr%20h', token))).toEqual(['HR Hari', 'HR Hema']);
    const byAddress = await get(`/staff?q=${encodeURIComponent(nurse.email.toUpperCase())}`, token);
    expect(names(byAddress)).toEqual(['Nurse Nila']);
    expect(errorOf(await get('/staff?cursor=nonsense', token))).toEqual([400, 'invalid_cursor']);
    // Text the database cannot store is refused, not passed on. And % is a character, not a wildcard.
    expect((await get('/staff?q=%00', token)).statusCode).toBe(400);
    expect(names(await get('/staff?q=%25', token))).toEqual([]);
  });

  it('shows deactivated members and open invitations as their own lists', async () => {
    const token = await signIn(admin);
    await act(nurse, 'deactivate', token);
    const sent = await invite(token);

    const deactivated = await get('/staff?status=deactivated', token);
    expect(deactivated.json<Page>().items).toMatchObject([
      { id: nurse.id, status: 'deactivated', roleId: 'nurse' },
    ]);
    expect(names(await get('/staff', token))).not.toContain('Nurse Nila');

    const invited = await get(`/staff?status=invited&q=${encodeURIComponent(sent.email)}`, token);
    expect(invited.json<Page>().items).toEqual([
      {
        id: sent.id,
        tenantId: hospital.id,
        name: 'Invited Ira',
        email: sent.email,
        roleId: 'nurse',
        roleName: 'Nurse',
        status: 'invited',
      },
    ]);
  });

  it('leaves out an invitation that has expired', async () => {
    const token = await signIn(admin);
    const sent = await invite(token);
    await pool.query("update invites set expires_at = now() - interval '1 minute' where id = $1", [
      sent.id,
    ]);

    const invited = await get(`/staff?status=invited&q=${encodeURIComponent(sent.email)}`, token);
    expect(invited.json<Page>().items).toEqual([]);
  });
});

describe('deactivating and reactivating', () => {
  it('ends the person’s work here at once, and keeps the membership', async () => {
    const nurseSession = await signIn(nurse);
    expect((await get('/tenant', nurseSession)).statusCode).toBe(200);

    const response = await act(nurse, 'deactivate', await signIn(admin));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: nurse.id, status: 'deactivated' });
    expect(await statusOf(nurse, hospital)).toBe('suspended');
    // The session they had is over, and a new one has no hospital to work at.
    expect((await get('/session', nurseSession)).statusCode).toBe(401);
    const again = await signIn(nurse);
    expect((await get('/session', again)).json().activeTenant).toBeNull();
    expect((await get('/tenant', again)).statusCode).toBe(409);
    expect(await audited(hospital, 'membership', nurse.id)).toContain('deactivate');
  });

  it('changes nothing the second time, and nothing of the person’s other hospitals', async () => {
    const token = await signIn(admin);
    const atClinic = await signIn(doctor, clinic);

    await act(doctor, 'deactivate', token);
    const before = await audited(hospital, 'membership', doctor.id);
    const second = await act(doctor, 'deactivate', token);

    expect(second.json()).toMatchObject({ status: 'deactivated' });
    expect(await audited(hospital, 'membership', doctor.id)).toEqual(before);
    // Still a doctor at the clinic, in the session that was already open there.
    expect(await statusOf(doctor, clinic)).toBe('active');
    expect((await get('/tenant', atClinic)).statusCode).toBe(200);
  });

  it('withdraws the open invitations the person sent', async () => {
    const sent = await invite(await signIn(hrColleague), 'hr_desk');

    await act(hrColleague, 'deactivate', await signIn(admin));

    const inspected = await app.inject({
      method: 'POST',
      url: '/auth/invite/inspect',
      headers: { origin: ORIGIN },
      payload: { token: sent.link },
    });
    expect(errorOf(inspected)).toEqual([400, 'invalid_token']);
  });

  it('brings a member back in the role they had', async () => {
    const token = await signIn(admin);
    await act(nurse, 'deactivate', token);

    const response = await act(nurse, 'reactivate', token);

    expect(response.json()).toMatchObject({ id: nurse.id, status: 'active', roleId: 'nurse' });
    expect((await get('/tenant', await signIn(nurse))).statusCode).toBe(200);
    // A session from before they were deactivated is not one of this hospital's again.
    expect(await cutOffOf(nurse, hospital)).not.toBeNull();
    expect(await audited(hospital, 'membership', nurse.id)).toContain('reactivate');
  });

  it('cannot be brought back by a new invitation: the membership is still there', async () => {
    const token = await signIn(admin);
    await act(nurse, 'deactivate', token);
    notifier.sent.length = 0;
    await send('POST', '/invites', token, {
      email: nurse.email,
      name: 'Nurse Nila',
      roleId: 'nurse',
    });
    const link = notifier.sent.at(-1)?.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1] ?? '';

    await app.inject({
      method: 'POST',
      url: '/auth/invite/accept',
      headers: { origin: ORIGIN },
      payload: { token: link },
    });

    expect(await statusOf(nurse, hospital)).toBe('suspended');
  });

  it('refuses the caller’s own membership, and has one answer for anyone not of this hospital', async () => {
    const token = await signIn(admin);

    expect(errorOf(await act(admin, 'deactivate', token))).toEqual([409, 'cannot_deactivate_self']);
    for (const id of [clinicAdmin.id, randomUUID(), 'not-an-id']) {
      for (const action of ['deactivate', 'reactivate', 'revoke-sessions']) {
        const response = await send('POST', `/staff/${id}/${action}`, token);
        expect(errorOf(response), `${action} ${id}`).toEqual([404, 'staff_not_found']);
      }
    }
    expect(await statusOf(clinicAdmin, clinic)).toBe('active');
  });

  it('does nothing for a caller who was deactivated while the request waited', async () => {
    const [adminToken, hrToken] = [await signIn(admin), await signIn(hr)];
    expect(adminToken).not.toBe('');
    // Someone holds the locks a deactivation takes, as another deactivation in progress would.
    const holder = await pool.connect();
    let waiting: Promise<LightMyRequestResponse>;
    try {
      await holder.query('begin');
      await holder.query(
        "select 1 from memberships where tenant_id = $1 and status = 'active' for update",
        [hospital.id],
      );
      // The HR desk asks to deactivate a colleague, and waits.
      waiting = act(hrColleague, 'deactivate', hrToken);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Meanwhile the HR desk itself is deactivated.
      await holder.query(
        "update memberships set status = 'suspended' where tenant_id = $1 and user_id = $2",
        [hospital.id, hr.id],
      );
      await holder.query('commit');
    } finally {
      holder.release();
    }

    expect(errorOf(await waiting)).toEqual([403, 'permission_denied']);
    expect(await statusOf(hrColleague, hospital)).toBe('active');
  });

  it('never leaves a hospital with nobody to manage its staff', async () => {
    // The clinic's two administrators deactivate each other at the same moment.
    const [one, two] = await Promise.all([signIn(clinicAdmin), signIn(clinicAdminTwo)]);

    const results = await Promise.all([
      act(clinicAdminTwo, 'deactivate', one),
      act(clinicAdmin, 'deactivate', two),
    ]);

    // Whoever gets the locks first decides. The other was deactivated while waiting, and is
    // refused as someone who is no longer a member.
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 403]);
    const refused = results.find((response) => response.statusCode === 403);
    expect(refused?.json().error.code).toBe('permission_denied');
    const { rows } = await pool.query(
      "select 1 from memberships where tenant_id = $1 and role_id = 'admin' and status = 'active'",
      [clinic.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('ending sessions', () => {
  it('ends every session the person has here, and they stay a member', async () => {
    const [first, second] = [await signIn(nurse), await signIn(nurse)];

    const response = await act(nurse, 'revoke-sessions', await signIn(admin));

    expect(response.json()).toEqual({ revoked: 2 });
    expect((await get('/session', first)).statusCode).toBe(401);
    expect((await get('/session', second)).statusCode).toBe(401);
    expect(await statusOf(nurse, hospital)).toBe('active');
    expect((await get('/tenant', await signIn(nurse))).statusCode).toBe(200);
  });

  it('keeps the caller’s own session when they end their own', async () => {
    const elsewhere = await signIn(admin);
    const here = await signIn(admin);

    const response = await act(admin, 'revoke-sessions', here);

    expect(response.json<{ revoked: number }>().revoked).toBeGreaterThanOrEqual(1);
    expect((await get('/session', elsewhere)).statusCode).toBe(401);
    expect((await get('/session', here)).statusCode).toBe(200);
  });

  it('covers a session that is not bound here: it can no longer be brought to this hospital', async () => {
    const atClinic = await signIn(doctor, clinic);
    const atPicker = await signIn(doctor);
    const switchTo = (token: string, tenant: TestTenant) =>
      send('POST', '/session/switch-tenant', token, { tenantId: tenant.id });

    const response = await act(doctor, 'revoke-sessions', await signIn(admin));
    expect(response.json()).toEqual({ revoked: 0 });

    // Neither session was bound to the hospital, and neither can come to it now.
    expect((await switchTo(atPicker, hospital)).statusCode).toBe(403);
    expect((await switchTo(atClinic, hospital)).statusCode).toBe(403);
    // The clinic is not concerned, and signing in again is all it takes.
    expect((await switchTo(atPicker, clinic)).statusCode).toBe(200);
    expect((await get('/tenant', await signIn(doctor, hospital))).statusCode).toBe(200);
  });

  it('does not let a session that was ended be reopened', async () => {
    const token = await signIn(nurse);
    await act(nurse, 'revoke-sessions', await signIn(admin));

    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query(
          'update sessions set revoked_at = null, revoke_reason = null where user_id = $1',
          [nurse.id],
        ),
      ),
    ).rejects.toThrow(/cannot be reopened/);
    expect((await get('/session', token)).statusCode).toBe(401);
  });

  it('leaves a session at another hospital alone', async () => {
    const atClinic = await signIn(doctor, clinic);

    await act(doctor, 'revoke-sessions', await signIn(admin));

    expect((await get('/tenant', atClinic)).statusCode).toBe(200);
  });
});

describe('withdrawing an invitation', () => {
  it('stops its link from working, once', async () => {
    const token = await signIn(admin);
    const sent = await invite(token);

    const withdrawn = await send('DELETE', `/invites/${sent.id}`, token);

    expect(withdrawn.statusCode).toBe(204);
    const inspected = await app.inject({
      method: 'POST',
      url: '/auth/invite/inspect',
      headers: { origin: ORIGIN },
      payload: { token: sent.link },
    });
    expect(errorOf(inspected)).toEqual([400, 'invalid_token']);
    expect(await audited(hospital, 'invite', sent.id)).toEqual(['withdraw']);
    expect(errorOf(await send('DELETE', `/invites/${sent.id}`, token))).toEqual([
      404,
      'invite_not_found',
    ]);
  });

  it('treats an expired invitation as not open: there is nothing to withdraw', async () => {
    const token = await signIn(admin);
    const sent = await invite(token);
    await pool.query("update invites set expires_at = now() - interval '1 minute' where id = $1", [
      sent.id,
    ]);

    expect(errorOf(await send('DELETE', `/invites/${sent.id}`, token))).toEqual([
      404,
      'invite_not_found',
    ]);
    expect(await audited(hospital, 'invite', sent.id)).toEqual([]);
  });

  it('has one answer for another hospital’s invitation and one that does not exist', async () => {
    const theirs = await invite(await signIn(clinicAdmin));
    const token = await signIn(admin);

    for (const id of [theirs.id, randomUUID(), 'not-an-id']) {
      expect(errorOf(await send('DELETE', `/invites/${id}`, token)), id).toEqual([
        404,
        'invite_not_found',
      ]);
    }
    const { rows } = await pool.query('select revoked_at from invites where id = $1', [theirs.id]);
    expect(rows[0]).toEqual({ revoked_at: null });
  });
});

describe('nobody acts above themselves', () => {
  it('offers only the roles the caller may give', async () => {
    const forHr = await get('/staff/roles', await signIn(hr));
    const forAdmin = await get('/staff/roles', await signIn(admin));

    const ids = (response: LightMyRequestResponse) =>
      response.json<{ items: { id: string; name: string }[] }>().items.map((role) => role.id);
    expect(ids(forHr)).toContain('hr_desk');
    expect(ids(forHr)).not.toContain('admin');
    expect(ids(forHr)).not.toContain('nurse');
    expect(ids(forAdmin)).toEqual(expect.arrayContaining(['admin', 'doctor', 'nurse', 'hr_desk']));
  });

  it('lets the HR desk act on its own kind, and on nobody who holds more', async () => {
    const token = await signIn(hr);

    for (const action of ['deactivate', 'reactivate', 'revoke-sessions'] as const) {
      expect(errorOf(await act(admin, action, token)), action).toEqual([403, 'role_not_allowed']);
      expect(errorOf(await act(nurse, action, token)), action).toEqual([403, 'role_not_allowed']);
    }
    expect(await statusOf(admin, hospital)).toBe('active');

    expect((await act(hrColleague, 'deactivate', token)).statusCode).toBe(200);
    expect((await act(hrColleague, 'reactivate', token)).statusCode).toBe(200);
  });

  it('does not let the HR desk withdraw an invitation it could not have sent', async () => {
    const sent = await invite(await signIn(admin), 'admin');

    const response = await send('DELETE', `/invites/${sent.id}`, await signIn(hr));

    expect(errorOf(response)).toEqual([403, 'role_not_allowed']);
  });
});

describe('access', () => {
  it('is closed to a role without the staff permissions, and to nobody signed in', async () => {
    const token = await signIn(nurse);

    expect(errorOf(await get('/staff', token))).toEqual([403, 'permission_denied']);
    expect(errorOf(await get('/staff/roles', token))).toEqual([403, 'permission_denied']);
    expect(errorOf(await act(doctor, 'deactivate', token))).toEqual([403, 'permission_denied']);
    expect(errorOf(await act(doctor, 'revoke-sessions', token))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await send('DELETE', `/invites/${randomUUID()}`, token))).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await app.inject({ url: '/staff' })).statusCode).toBe(401);
  });
});

describe('two hospitals', () => {
  it('shows each hospital its own people only', async () => {
    const atClinic = await get('/staff', await signIn(clinicAdmin));

    expect(names(atClinic)).toEqual(['Clinic Admin One', 'Clinic Admin Two', 'Doctor Dev']);
    expect(atClinic.json<Page>().items.every((item) => item.tenantId === clinic.id)).toBe(true);
  });

  it('is kept apart by the database itself, whatever the SQL', async () => {
    const session = await signIn(clinicAdmin);
    expect(session).not.toBe('');

    const seen = await asTenantSql(pool, hospital.id, async (client) => ({
      // Names and addresses of this hospital's members, and of nobody else.
      people: (await client.query<{ name: string }>('select name from users order by name')).rows,
      // The clinic admin's session is bound to the clinic.
      sessions: (await client.query('select 1 from sessions where user_id = $1', [clinicAdmin.id]))
        .rowCount,
      ended: (
        await client.query(
          "update sessions set revoked_at = now(), revoke_reason = 'admin' where user_id = $1",
          [clinicAdmin.id],
        )
      ).rowCount,
      moved: (
        await client.query("update memberships set status = 'suspended' where user_id = $1", [
          clinicAdmin.id,
        ])
      ).rowCount,
    }));

    expect(seen.people.map((row) => row.name)).toEqual([
      'Doctor Dev',
      'HR Hari',
      'HR Hema',
      'Nurse Nila',
      'Staff Admin',
    ]);
    expect(seen).toMatchObject({ sessions: 0, ended: 0, moved: 0 });
    expect((await get('/session', session)).statusCode).toBe(200);
  });

  it('gives a hospital’s requests no more of an account than a name and an address', async () => {
    for (const statement of [
      'select status from users',
      'select locked_until from users',
      'select token_hash from sessions',
      "update users set name = 'Renamed'",
      "update memberships set role_id = 'admin'",
      'delete from memberships',
      'update sessions set active_tenant_id = null',
    ]) {
      await expect(
        asTenantSql(pool, hospital.id, (client) => client.query(statement)),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
