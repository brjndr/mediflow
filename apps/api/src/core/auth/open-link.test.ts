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
  testConfig,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/**
 * Deep links (#1089) through the real app and database: sessions come from the cookie.
 */

const COOKIE = 'mediflow_session';
const ORIGIN = testConfig().APP_BASE_URL;

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let elsewhere: TestTenant;
/** Works at the hospital and the clinic. */
let doctor: TestUser;
/** Works at the hospital only. */
let nurse: TestUser;
let atHospital: string;
let atClinic: string;
let atElsewhere: string;

async function addPatient(tenant: TestTenant, by: TestUser, label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, $3, 'Linked', '1980-05-01', 'female', '+91 9800000000', $4) returning id`,
    [tenant.id, `OL-${label}-${tenant.id.slice(0, 6)}`, label, by.id],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  app = await buildTestApp({ config: { AUTH_RATE_LIMIT_PER_MINUTE: 10_000 } });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Link Hospital');
  clinic = await createTenant(pool, 'Link Clinic');
  elsewhere = await createTenant(pool, 'Link Elsewhere');
  doctor = await createUser(pool, 'Doctor Link');
  nurse = await createUser(pool, 'Nurse Link');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, doctor, clinic, 'doctor');
  await addMembership(pool, nurse, hospital, 'nurse');
  atHospital = await addPatient(hospital, doctor, 'hospital');
  atClinic = await addPatient(clinic, doctor, 'clinic');
  atElsewhere = await addPatient(elsewhere, doctor, 'elsewhere');
});

afterAll(async () => {
  // Patients do not cascade with their hospital.
  await pool.query('delete from patients where id = any($1::uuid[])', [
    [atHospital, atClinic, atElsewhere],
  ]);
  await deleteUsers(pool, [doctor, nurse]);
  await deleteTenants(pool, [hospital, clinic, elsewhere]);
  await app.close();
});

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((cookie) => cookie.name === COOKIE)?.value;

/** Signs in and makes `tenant` the active hospital; returns the cookie's token. */
async function signInAt(user: TestUser, tenant: TestTenant): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ORIGIN },
    payload: { email: user.email, password: user.password },
  });
  const token = cookieOf(login);
  if (login.statusCode !== 200 || !token) throw new Error('sign-in failed in test setup');
  const switched = await app.inject({
    method: 'POST',
    url: '/session/switch-tenant',
    headers: { origin: ORIGIN },
    cookies: { [COOKIE]: token },
    payload: { tenantId: tenant.id },
  });
  return cookieOf(switched) ?? token;
}

const openLink = (token: string | null, payload: object) =>
  app.inject({
    method: 'POST',
    url: '/session/open-link',
    headers: { origin: ORIGIN },
    ...(token ? { cookies: { [COOKIE]: token } } : {}),
    payload,
  });

const activeTenant = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/session', cookies: { [COOKIE]: token } })).json<{
    activeTenant: { id: string } | null;
  }>().activeTenant?.id;

describe('opening a deep link', () => {
  it('opens a record of the active hospital without moving the session', async () => {
    const token = await signInAt(doctor, hospital);
    const response = await openLink(token, { kind: 'patient', id: atHospital });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ activeTenant: { id: hospital.id } });
    expect(cookieOf(response)).toBeUndefined();
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it("moves the session to the record's hospital when the user works there too", async () => {
    const token = await signInAt(doctor, hospital);
    const response = await openLink(token, { kind: 'patient', id: atClinic });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ activeTenant: { id: clinic.id } });
    const next = cookieOf(response);
    expect(next).toBeDefined();
    expect(next).not.toBe(token);
    expect(await activeTenant(next!)).toBe(clinic.id);
  });

  it('records the open in the audit log of the hospital that owns the record', async () => {
    const token = await signInAt(doctor, hospital);
    await openLink(token, { kind: 'patient', id: atClinic });
    const rows = await asTenantSql(
      pool,
      clinic.id,
      async (client) =>
        (
          await client.query<{ actor_id: string; action: string; entity: string }>(
            `select actor_id, action, entity from audit_log
           where entity_id = $1 and action = 'open_link'`,
            [atClinic],
          )
        ).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual({ actor_id: doctor.id, action: 'open_link', entity: 'patient' });
  });

  it('gives one identical refusal for every reason, and leaves the session where it was', async () => {
    const token = await signInAt(nurse, hospital);
    const refusals = await Promise.all([
      // A hospital the nurse does not work at.
      openLink(token, { kind: 'patient', id: atClinic }),
      // No such record.
      openLink(token, { kind: 'patient', id: '6d1f3b4e-0000-4000-8000-000000000000' }),
      // No such kind, and a kind only the web app's mock knows.
      openLink(token, { kind: 'invoice', id: atHospital }),
      openLink(token, { kind: 'notice', id: atHospital }),
      // Not an id.
      openLink(token, { kind: 'patient', id: 'not-an-id' }),
    ]);
    const bodies = refusals.map((response) => {
      const body = response.json<{ error: { code: string; message: string } }>();
      return [response.statusCode, body.error.code, body.error.message];
    });
    for (const body of bodies) {
      expect(body).toEqual([403, 'link_unavailable', 'This link is not available']);
    }
    expect(refusals.every((response) => cookieOf(response) === undefined)).toBe(true);
    expect(await activeTenant(token)).toBe(hospital.id);
  });

  it('refuses a hospital that has ended the sessions this one belongs to', async () => {
    const token = await signInAt(doctor, hospital);
    await pool.query(
      `update memberships set sessions_valid_after = now() + interval '1 second'
       where user_id = $1 and tenant_id = $2`,
      [doctor.id, clinic.id],
    );
    try {
      const response = await openLink(token, { kind: 'patient', id: atClinic });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'link_unavailable']);
    } finally {
      await pool.query(
        'update memberships set sessions_valid_after = null where user_id = $1 and tenant_id = $2',
        [doctor.id, clinic.id],
      );
    }
  });

  it('refuses a record of a hospital the user never belonged to, though the doctor works at two', async () => {
    const token = await signInAt(doctor, hospital);
    const response = await openLink(token, { kind: 'patient', id: atElsewhere });
    expect([response.statusCode, response.json().error.code]).toEqual([403, 'link_unavailable']);
    expect(await activeTenant(token)).toBe(hospital.id);
  });

  it('needs a session', async () => {
    const response = await openLink(null, { kind: 'patient', id: atHospital });
    expect(response.statusCode).toBe(401);
  });

  it('looks up through a role that sees a patient’s hospital and nothing else', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_link');
      const { rows } = await client.query<{ tenant_id: string }>(
        'select tenant_id from patients where id = $1',
        [atClinic],
      );
      expect(rows).toEqual([{ tenant_id: clinic.id }]);
      await expect(
        client.query('select first_name from patients where id = $1', [atClinic]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
    // Requests cannot run the lookup at all.
    await asTenantSql(pool, hospital.id, async (client) => {
      await expect(
        client.query('select patient_link_owner($1::uuid)', [atClinic]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('accepts only plain names when a feature registers a kind', () => {
    expect(() => app.links.register('Bad Kind', 'patient_link_owner')).toThrow(/not a valid name/);
    expect(() => app.links.register('thing', 'x; drop table patients')).toThrow(/not a function/);
    expect(() => app.links.register('patient', 'patient_link_owner')).toThrow(/twice/);
  });
});
