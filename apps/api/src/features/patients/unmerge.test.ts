import { randomUUID } from 'node:crypto';
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

/** Undoing a merge inside the hospital's window (#555). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let other: TestTenant;
let admin: TestUser;
let otherAdmin: TestUser;
let doctor: TestUser;
let seq = 0;

async function patient(tenant: TestTenant, by: TestUser) {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Un', 'Merge', '1980-05-01', 'female', '+91 9800000000', $3) returning id`,
    [tenant.id, `UM-${tenant.id.slice(0, 4)}-${seq}`, by.id],
  );
  return rows[0]!.id;
}
const version = async (id: string) =>
  (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
    .rows[0]!.version;
const document = async (patientId: string) =>
  (
    await pool.query<{ id: string }>(
      `insert into patient_documents (tenant_id, patient_id, category, title, file_name,
         content_type, size_bytes, status, uploaded_at, created_by)
       values ($1, $2, 'other', 'Scan', 'scan.pdf', 'application/pdf', 100, 'clean', now(), $3)
       returning id`,
      [hospital.id, patientId, admin.id],
    )
  ).rows[0]!.id;
const documentOwner = async (id: string) =>
  (
    await pool.query<{ patient_id: string; original_patient_id: string | null }>(
      'select patient_id, original_patient_id from patient_documents where id = $1',
      [id],
    )
  ).rows[0]!;

async function merge(target: string, source: string, user: TestUser = admin) {
  return app.inject({
    method: 'POST',
    url: `/patients/${target}/merge`,
    headers: { ...as(hospital.id, user.id), 'idempotency-key': randomUUID() },
    payload: {
      sourcePatientId: source,
      reason: 'Duplicate registration',
      expectedVersion: await version(target),
      expectedSourceVersion: await version(source),
    },
  });
}
const unmerge = (source: string, user: TestUser = admin, tenant: TestTenant = hospital) =>
  app.inject({
    method: 'POST',
    url: `/patients/${source}/unmerge`,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': randomUUID() },
    payload: { reason: 'Merged the wrong person' },
  });
const setWindow = (days: number) =>
  app.inject({
    method: 'PUT',
    url: '/patient-settings',
    headers: as(hospital.id, admin.id),
    payload: { unmergeWindowDays: days },
  });

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Unmerge Hospital', {
    features: { patients: true, documents: true },
  });
  other = await createTenant(pool, 'Unmerge Other Hospital', { features: { patients: true } });
  await grantRoleDefaults(app, hospital);
  await grantRoleDefaults(app, other);
  admin = await createUser(pool, 'Unmerge Admin', { withPassword: false });
  otherAdmin = await createUser(pool, 'Unmerge Other Admin', { withPassword: false });
  doctor = await createUser(pool, 'Unmerge Doctor', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, otherAdmin, other, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const tenant of [hospital, other]) {
      for (const table of [
        'document_legal_holds',
        'patient_documents',
        'patient_merges',
        'patient_settings',
        'outbox',
        'patients',
      ]) {
        await client.query(`delete from ${table} where tenant_id = $1`, [tenant.id]);
      }
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, other]);
  await deleteUsers(pool, [admin, otherAdmin, doctor]);
  await app.close();
});

const hold = (tenant: TestTenant, patientId: string, by: TestUser) =>
  pool.query(
    `insert into document_legal_holds (tenant_id, patient_id, reason, placed_by)
     values ($1, $2, 'Inquiry', $3)`,
    [tenant.id, patientId, by.id],
  );
const openHolds = async (patientId: string) =>
  (
    await pool.query<{ reason: string }>(
      'select reason from document_legal_holds where patient_id = $1 and released_at is null',
      [patientId],
    )
  ).rowCount;

describe('unmerging patients', () => {
  it('releases the legal hold the merge copied, and only that one', async () => {
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    const foreign = await patient(other, otherAdmin);
    await hold(hospital, source, admin);
    await hold(hospital, target, admin); // placed by hand on the survivor
    await hold(other, foreign, otherAdmin);
    expect((await merge(target, source)).statusCode).toBe(201);
    expect(await openHolds(target)).toBe(2);

    expect((await unmerge(source)).statusCode).toBe(200);
    expect(await openHolds(target)).toBe(1);
    expect(await openHolds(source)).toBe(1); // the source's own hold is untouched
    expect(await openHolds(foreign)).toBe(1);
    const released = await pool.query<{ released_by: string; id: string }>(
      `select id, released_by from document_legal_holds
        where patient_id = $1 and released_at is not null`,
      [target],
    );
    expect(released.rows).toHaveLength(1);
    expect(released.rows[0]!.released_by).toBe(admin.id);
    const audit = await pool.query(
      `select 1 from audit_log where entity = 'document_legal_hold' and entity_id = $1
         and actor_id = $2 and detail like 'unmerge:%'`,
      [released.rows[0]!.id, admin.id],
    );
    expect(audit.rowCount).toBe(1);

    // Merging again copies the source's hold again, and a second unmerge releases it too.
    expect((await merge(target, source)).statusCode).toBe(201);
    expect(await openHolds(target)).toBe(2);
    expect((await unmerge(source)).statusCode).toBe(200);
    expect(await openHolds(target)).toBe(1);
  });

  it('gives the record and its documents back inside the window', async () => {
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    const doc = await document(source);
    const own = await document(target);
    expect((await merge(target, source)).statusCode).toBe(201);
    expect((await documentOwner(doc)).patient_id).toBe(target);

    const response = await unmerge(source);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourcePatientId: source,
      targetPatientId: target,
      unmergeReason: 'Merged the wrong person',
      unmergedBy: admin.id,
    });
    expect(await documentOwner(doc)).toEqual({ patient_id: source, original_patient_id: null });
    expect((await documentOwner(own)).patient_id).toBe(target);

    const read = await app.inject({
      url: `/patients/${source}`,
      headers: as(hospital.id, admin.id),
    });
    expect(read.json()).not.toHaveProperty('mergedInto');
    const event = await pool.query(
      `select 1 from outbox where tenant_id = $1 and event = 'patient.unmerged'`,
      [hospital.id],
    );
    expect(event.rowCount).toBeGreaterThan(0);

    // Unmerged records can be merged again.
    expect((await merge(target, source)).statusCode).toBe(201);
    // And a record that is not merged cannot be unmerged.
    expect((await unmerge(target)).json()).toMatchObject({ error: { code: 'not_merged' } });
  });

  it('refuses after the window and when unmerging is off', async () => {
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    expect((await merge(target, source)).statusCode).toBe(201);
    await pool.query(`alter table patient_merges disable trigger patient_merges_guard_update`);
    await pool.query(
      `update patient_merges set merged_at = now() - interval '31 days' where source_patient_id = $1`,
      [source],
    );
    await pool.query(`alter table patient_merges enable trigger patient_merges_guard_update`);
    const late = await unmerge(source);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: 'unmerge_window_closed' } });

    expect((await setWindow(60)).json()).toEqual({ unmergeWindowDays: 60 });
    expect((await unmerge(source)).statusCode).toBe(200);

    const again = await patient(hospital, admin);
    const away = await patient(hospital, admin);
    expect((await merge(again, away)).statusCode).toBe(201);
    await setWindow(0);
    expect((await unmerge(away)).json()).toMatchObject({
      error: { code: 'unmerge_window_closed' },
    });
    await setWindow(30);
  });

  it('is for patient:unmerge only, and stays inside the hospital', async () => {
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    expect((await merge(target, source)).statusCode).toBe(201);
    expect((await unmerge(source, doctor)).statusCode).toBe(403);
    expect((await unmerge(source, otherAdmin, other)).statusCode).toBe(404);
    const settings = await app.inject({
      url: '/patient-settings',
      headers: as(hospital.id, doctor.id),
    });
    expect(settings.statusCode).toBe(403);
    expect((await unmerge(source)).statusCode).toBe(200);
  });

  it('keeps the database from clearing a merge any other way', async () => {
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    expect((await merge(target, source)).statusCode).toBe(201);
    await expect(
      pool.query('update patients set merged_into_id = null where id = $1', [source]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses when the survivor was merged away since', async () => {
    const root = await patient(hospital, admin);
    const target = await patient(hospital, admin);
    const source = await patient(hospital, admin);
    expect((await merge(target, source)).statusCode).toBe(201);
    expect((await merge(root, target)).statusCode).toBe(201);
    const response = await unmerge(source);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'patient_merged' } });
  });
});
