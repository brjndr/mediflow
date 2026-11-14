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

/**
 * Reads that follow a patient merge and writes refused for the record merged away, through the
 * routes of each module (#843). The database trigger of migration 0107 is tested in
 * `merge-follow.test.ts`; here the error handler's answer is checked per module.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let other: TestTenant;
let admin: TestUser;
let otherAdmin: TestUser;
let doctorUser: TestUser;
let departmentId = '';
let doctorId = '';
let seq = 0;
const ids = { target: '', source: '', foreign: '' };

async function patient(tenant: TestTenant) {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Module', 'Merge', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `MM-${tenant.id.slice(0, 4)}-${seq}`],
  );
  return rows[0]!.id;
}
const version = async (id: string) =>
  (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
    .rows[0]!.version;
const errorOf = (r: { statusCode: number; json: () => unknown }) => [
  r.statusCode,
  (r.json() as { error: { code: string } }).error.code,
];
const post = (url: string, payload: object, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...as(tenant.id, user.id), 'idempotency-key': randomUUID() },
    payload,
  });
const put = (url: string, payload: object) =>
  app.inject({ method: 'PUT', url, headers: as(hospital.id, admin.id), payload });

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = {
    patients: true,
    appointments: true,
    queue: true,
    triage: true,
    admissions: true,
  };
  hospital = await createTenant(pool, 'Merge Modules Hospital', { features });
  other = await createTenant(pool, 'Merge Modules Other', { features });
  await grantRoleDefaults(app, hospital);
  await grantRoleDefaults(app, other);
  admin = await createUser(pool, 'Merge Modules Admin', { withPassword: false });
  otherAdmin = await createUser(pool, 'Merge Modules Other Admin', { withPassword: false });
  doctorUser = await createUser(pool, 'Merge Modules Doctor', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, otherAdmin, other, 'admin');
  await addMembership(pool, doctorUser, hospital, 'doctor');
  departmentId = (
    await pool.query<{ id: string }>(
      'insert into departments (tenant_id, name) values ($1, $2) returning id',
      [hospital.id, 'General'],
    )
  ).rows[0]!.id;
  doctorId = (
    await pool.query<{ id: string }>(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General practice', 15) returning id`,
      [hospital.id, doctorUser.id, departmentId],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
     select $1, $2, day, 540, 780 from generate_series(1, 7) as day`,
    [hospital.id, doctorId],
  );
  ids.target = await patient(hospital);
  ids.source = await patient(hospital);
  ids.foreign = await patient(other);
  await pool.query(
    `insert into allergy_lists (tenant_id, patient_id, status, items, updated_by)
     values ($1, $2, 'listed', $3::jsonb, $4), ($5, $6, 'listed', $7::jsonb, $8)`,
    [
      hospital.id,
      ids.source,
      JSON.stringify([{ substance: 'Penicillin', severity: 'severe' }]),
      admin.id,
      other.id,
      ids.foreign,
      JSON.stringify([{ substance: 'Peanuts', severity: 'mild' }]),
      otherAdmin.id,
    ],
  );
  await insertStayWithoutGuard(hospital.id, ids.source);
  await insertStayWithoutGuard(other.id, ids.foreign, true);
  const merged = await post(`/patients/${ids.target}/merge`, {
    sourcePatientId: ids.source,
    reason: 'Duplicate registration',
    expectedVersion: await version(ids.target),
    expectedSourceVersion: await version(ids.source),
  });
  if (merged.statusCode !== 201) throw new Error(`merge failed in setup: ${merged.body}`);
}, 60_000);

/** A stay written as the other hospital's own data would be, without needing its doctor. */
async function insertStayWithoutGuard(tenantId: string, patientId: string, foreign = false) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      `insert into admissions (tenant_id, patient_id, encounter_id, admitting_doctor_id, department_id,
         admission_type, admitted_by, status, discharged_at, discharged_by, discharge_type)
       values ($1, $2, gen_random_uuid(), $3, $4, 'planned', $5, 'discharged', now(), $5, 'routine')`,
      [tenantId, patientId, doctorId, departmentId, foreign ? otherAdmin.id : admin.id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const tenants = [hospital.id, other.id];
    for (const table of [
      'allergy_list_versions',
      'allergy_lists',
      'admissions',
      'queue_tokens',
      'queue_counters',
      'appointments',
      'doctor_hours',
      'doctors',
      'departments',
      'patient_merges',
      'outbox',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, other]);
  await deleteUsers(pool, [admin, otherAdmin, doctorUser]);
  await app.close();
});

describe('reads follow a merge', () => {
  it('shows the merged-away allergies on the survivor, and no other hospital', async () => {
    const response = await app.inject({
      url: `/patients/${ids.target}/allergies`,
      headers: as(hospital.id, admin.id),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      items: { substance: string }[];
      version: number;
    }>();
    expect(body.status).toBe('listed');
    expect(body.items.map((item) => item.substance)).toEqual(['Penicillin']);
    expect(body.version).toBe(0);
  });

  it('reads the merged-away id through its survivor, so a later allergy is warned (#865)', async () => {
    await pool.query(
      `insert into allergy_lists (tenant_id, patient_id, status, items, updated_by)
       values ($1, $2, 'listed', $3::jsonb, $4)`,
      [
        hospital.id,
        ids.target,
        JSON.stringify([{ substance: 'Aspirin', severity: 'mild' }]),
        admin.id,
      ],
    );
    try {
      for (const id of [ids.source, ids.target]) {
        const response = await app.inject({
          url: `/patients/${id}/allergies`,
          headers: as(hospital.id, admin.id),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{ patientId: string; items: { substance: string }[] }>();
        expect(body.patientId).toBe(ids.target);
        expect(body.items.map((item) => item.substance).sort()).toEqual(['Aspirin', 'Penicillin']);
      }
      const other = await app.inject({
        url: `/patients/${ids.foreign}/allergies`,
        headers: as(hospital.id, admin.id),
      });
      expect(other.statusCode).toBe(404);
    } finally {
      await pool.query('delete from allergy_lists where patient_id = $1', [ids.target]);
    }
  });

  it('lists the merged-away stay under the survivor, inside the hospital', async () => {
    const response = await app.inject({
      url: `/admissions?patientId=${ids.target}`,
      headers: as(hospital.id, admin.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { patientId: string }[] }>().items).toEqual([
      expect.objectContaining({ patientId: ids.source }),
    ]);
    const foreign = await app.inject({
      url: `/admissions?patientId=${ids.foreign}`,
      headers: as(hospital.id, admin.id),
    });
    expect(foreign.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe('writes for a merged-away patient answer 409 patient_merged', () => {
  it('queue: issuing a token', async () => {
    const response = await post('/queue/tokens', { patientId: ids.source, departmentId });
    expect(errorOf(response)).toEqual([409, 'patient_merged']);
  });

  it('allergies: recording a first list', async () => {
    await pool
      .query('delete from allergy_lists where patient_id = $1', [ids.source])
      .catch(() => 0);
    const response = await put(`/patients/${ids.source}/allergies`, {
      status: 'listed',
      version: 0,
      items: [{ substance: 'Dust', severity: 'mild' }],
    });
    expect(response.statusCode).toBe(409);
  });

  it('admissions: admitting the patient', async () => {
    const response = await post('/admissions', {
      patientId: ids.source,
      admissionType: 'planned',
      doctorId,
    });
    expect(errorOf(response)).toEqual([409, 'patient_merged']);
  });

  it('appointments: booking a slot', async () => {
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const free = await app.inject({
      url: `/appointments/free-slots?doctorId=${doctorId}&day=${day}`,
      headers: as(hospital.id, admin.id),
    });
    const slot = free.json<{ slots: { startsAt: string }[] }>().slots[0];
    expect(slot).toBeDefined();
    const response = await post('/appointments', {
      patientId: ids.source,
      doctorId,
      startsAt: slot!.startsAt,
    });
    expect(errorOf(response)).toEqual([409, 'patient_merged']);
  });
});
