import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
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
 * The hospital profile through the real app and database: reading and changing the letterhead
 * details with a version, tidying, permissions, the hospital boundary and audit.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;
let doctor: TestUser;

interface Profile {
  address?: string;
  phone?: string;
  registrationNumber?: string;
  gstin?: string;
  version: number;
}

const read = (tenant = hospital, user = admin) =>
  app.inject({ url: '/hospital-profile', headers: as(tenant.id, user.id) });
const change = (body: object, tenant = hospital, user = admin) =>
  app.inject({
    method: 'PATCH',
    url: '/hospital-profile',
    headers: as(tenant.id, user.id),
    payload: body,
  });
const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [
  response.statusCode,
  response.json().error.code,
];

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Profile Hospital');
  clinic = await createTenant(pool, 'Profile Clinic');
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Profile Admin', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Profile Clinic Admin', { withPassword: false });
  doctor = await createUser(pool, 'Profile Doctor', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
});

afterAll(async () => {
  await deleteUsers(pool, [admin, clinicAdmin, doctor]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

describe('the hospital profile', () => {
  it('starts with nothing set', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json<Profile>()).toEqual({ version: 1 });
  });

  it('changes the details, tidied, and records who did', async () => {
    const response = await change({
      address: '  12 Sample Road \n\n\n Bengaluru 560038 ',
      phone: ' +91  80 1234 5678 ',
      registrationNumber: ' KPME/123 ',
      gstin: '29abcde1234f1z5',
      expectedVersion: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Profile>()).toEqual({
      address: '12 Sample Road\n\nBengaluru 560038',
      phone: '+91 80 1234 5678',
      registrationNumber: 'KPME/123',
      gstin: '29ABCDE1234F1Z5',
      version: 2,
    });
    const { rows } = await pool.query(
      `select action from audit_log where tenant_id = $1 and entity = 'hospital_profile'`,
      [hospital.id],
    );
    expect(rows).toEqual([{ action: 'update' }]);
  });

  it('leaves out what is not sent and removes what is sent empty', async () => {
    const response = await change({ phone: '', expectedVersion: 2 });

    const profile = response.json<Profile>();
    expect(profile.phone).toBeUndefined();
    expect(profile.registrationNumber).toBe('KPME/123');
    expect(profile.version).toBe(3);
  });

  it('writes nothing when nothing changes', async () => {
    const response = await change({ registrationNumber: 'KPME/123', expectedVersion: 3 });
    expect(response.json<Profile>().version).toBe(3);
  });

  it('refuses a change made from an older version', async () => {
    expect(errorOf(await change({ address: 'Elsewhere', expectedVersion: 1 }))).toEqual([
      409,
      'conflict',
    ]);
  });

  it('lets one of two changes made from the same version through', async () => {
    const { version } = (await read()).json<Profile>();
    const results = await Promise.all([
      change({ phone: '111', expectedVersion: version }),
      change({ phone: '222', expectedVersion: version }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  });

  it('refuses a GSTIN that is not one and text with control characters', async () => {
    const { version } = (await read()).json<Profile>();
    expect((await change({ gstin: 'nope', expectedVersion: version })).statusCode).toBe(400);
    expect((await change({ phone: 'a\u0000b', expectedVersion: version })).statusCode).toBe(400);
    expect((await change({ phone: 'x'.repeat(51), expectedVersion: version })).statusCode).toBe(
      400,
    );
  });
});

describe('who may see and change it', () => {
  it('gives a role without the permission neither', async () => {
    expect(errorOf(await read(hospital, doctor))).toEqual([403, 'permission_denied']);
    expect(errorOf(await change({ phone: '1', expectedVersion: 1 }, hospital, doctor))).toEqual([
      403,
      'permission_denied',
    ]);
  });

  it('keeps one hospital out of another’s profile', async () => {
    const before = (await read(clinic, clinicAdmin)).json<Profile>();
    expect(before.address).toBeUndefined();
    // The same user reaching for the other hospital is refused as a non-member.
    expect((await read(clinic, admin)).statusCode).toBe(403);
    expect(
      (await change({ phone: '9', expectedVersion: before.version }, clinic, admin)).statusCode,
    ).toBe(403);
    // And a change in one never lands in the other.
    await change({ address: 'Only here', expectedVersion: before.version }, clinic, clinicAdmin);
    expect((await read()).json<Profile>().address).not.toBe('Only here');
  });
});
