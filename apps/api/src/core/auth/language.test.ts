import type { FastifyInstance } from 'fastify';
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
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/** A person's own language (#766): saved per user, returned with the session. */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;
let app: FastifyInstance;
let pool: pg.Pool;
const users: TestUser[] = [];
const tenants: TestTenant[] = [];

beforeAll(async () => {
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 } });
  pool = app.database.pool;
});

afterAll(async () => {
  await deleteUsers(pool, users);
  await deleteTenants(pool, tenants);
  await app.close();
});

async function signedIn(name: string, hospital: TestTenant) {
  const user = await createUser(pool, name);
  users.push(user);
  await addMembership(pool, user, hospital, 'nurse');
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: user.email, password: user.password },
  });
  const token = response.cookies.find((c) => c.name === COOKIE)?.value as string;
  return token;
}

const put = (token: string, payload: object) =>
  app.inject({
    method: 'PUT',
    url: '/auth/language',
    headers: { origin: ORIGIN },
    cookies: { [COOKIE]: token },
    payload,
  });
const languageOf = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/session', cookies: { [COOKIE]: token } })).json<{
    user: { language: string | null };
  }>().user.language;

describe('the user language', () => {
  it('lets two users of one hospital choose differently, and leaves a third unset', async () => {
    const hospital = await createTenant(pool, 'Language Hospital');
    tenants.push(hospital);
    const a = await signedIn('Language A', hospital);
    const b = await signedIn('Language B', hospital);
    const c = await signedIn('Language C', hospital);

    expect((await put(a, { language: 'hi' })).statusCode).toBe(204);
    expect((await put(b, { language: 'en' })).statusCode).toBe(204);

    expect(await languageOf(a)).toBe('hi');
    expect(await languageOf(b)).toBe('en');
    expect(await languageOf(c)).toBeNull();
  });

  it('clears the choice with null and refuses other languages', async () => {
    const hospital = await createTenant(pool, 'Language Hospital Two');
    tenants.push(hospital);
    const a = await signedIn('Language D', hospital);
    await put(a, { language: 'hi' });
    expect((await put(a, { language: null })).statusCode).toBe(204);
    expect(await languageOf(a)).toBeNull();
    expect((await put(a, { language: 'fr' })).statusCode).toBe(400);
    expect((await put(a, {})).statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/auth/language',
      headers: { origin: ORIGIN },
      payload: { language: 'hi' },
    });
    expect(response.statusCode).toBe(401);
  });
});
