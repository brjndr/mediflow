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
  hospitalDay,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/** Claims follow a patient merge, and back on an unmerge (#1044). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
let keys = 0;
const headers = (user: TestUser = admin, tenant: TestTenant = hospital) => ({
  ...as(tenant.id, user.id),
  'idempotency-key': `cm-key-${String(++keys).padStart(6, '0')}`,
});
const get = (url: string, user: TestUser = admin, tenant: TestTenant = hospital) =>
  app.inject({ url, headers: headers(user, tenant) });
const post = (url: string, payload: object, user: TestUser = admin, tenant = hospital) =>
  app.inject({ method: 'POST', url, headers: headers(user, tenant), payload });
async function ok<Body>(response: Response, status = 200): Promise<Body> {
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return response.json<Body>();
}
const one = async (sql: string, params: unknown[]) =>
  ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

let mrn = 0;
let codes = 0;

async function newPatient(tenant: TestTenant = hospital) {
  const patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Cm', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CM-${String(++mrn).padStart(7, '0')}`],
  );
  return patientId;
}

/** Cover for a patient, once. */
async function cover(patientId: string, tenant: TestTenant, user: TestUser) {
  const org = await ok<{ id: string }>(
    await post(
      '/payers',
      { kind: 'insurer', code: `CMP${++codes}`, name: `Cm Payer ${codes}` },
      user,
      tenant,
    ),
    201,
  );
  const plan = await ok<{ id: string }>(
    await post(
      `/payers/${org.id}/plans`,
      {
        code: `CMPL${++codes}`,
        name: `Cm Plan ${codes}`,
        coverageMode: 'all_except',
        copayPercent: 0,
        preAuthRequired: false,
        services: [],
      },
      user,
      tenant,
    ),
    201,
  );
  await ok(
    await post(
      `/patients/${patientId}/policies`,
      {
        planId: plan.id,
        policyNumber: `POL-${++codes}`,
        holderName: 'Holder',
        relationship: 'self',
        validFrom: hospitalDay(-30),
      },
      user,
      tenant,
    ),
    201,
  );
}

/** A visit with a charge, and a draft claim for it. */
async function claimFor(patientId: string, tenant: TestTenant = hospital, user: TestUser = admin) {
  const encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [tenant.id, patientId, user.id],
  );
  const serviceId = await one(
    `insert into services (tenant_id, code, name, category, tax_class) values ($1, $2, 'Cm Service', 'procedure', 'exempt') returning id`,
    [tenant.id, `CMS-${++codes}`],
  );
  await pool.query(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor)
     values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, 100000)`,
    [tenant.id, encounterId, patientId, serviceId, `cm-test:${++keys}`],
  );
  const made = await ok<{ id: string }>(
    await post(`/encounters/${encounterId}/claims`, { documents: [] }, user, tenant),
    201,
  );
  return made.id;
}

async function document(patientId: string) {
  return one(
    `insert into patient_documents (tenant_id, patient_id, category, title, file_name, content_type,
       size_bytes, status, uploaded_at, created_by)
     values ($1, $2, 'insurance', 'Discharge summary', 'dc.pdf', 'application/pdf', 1000, 'clean',
       now(), $3) returning id`,
    [hospital.id, patientId, admin.id],
  );
}

const patientOf = async (claimId: string) =>
  (
    await pool.query<{ patient_id: string }>('select patient_id from claims where id = $1', [
      claimId,
    ])
  ).rows[0]!.patient_id;

async function versionOf(patientId: string) {
  return (
    await pool.query<{ version: number }>('select version from patients where id = $1', [patientId])
  ).rows[0]!.version;
}

async function merge(sourceId: string, targetId: string) {
  return post(`/patients/${targetId}/merge`, {
    sourcePatientId: sourceId,
    reason: 'Same person',
    expectedVersion: await versionOf(targetId),
    expectedSourceVersion: await versionOf(sourceId),
  });
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { insurance: true, patients: true, billing: true, documents: true };
  hospital = await createTenant(pool, 'Cm Hospital', { features: on });
  clinic = await createTenant(pool, 'Cm Clinic', { features: on });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Cm Admin', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Cm Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
}, 60_000);

afterAll(async () => {
  try {
    const tenants = [hospital, clinic].filter(Boolean).map((tenant) => tenant.id);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      for (const table of [
        'claim_merge_moves',
        'claim_documents',
        'patient_documents',
        'claim_events',
        'claims',
        'claim_counters',
        'coverage_splits',
        'patient_policies',
        'payer_plan_services',
        'payer_plans',
        'payers',
        'charges',
        'encounters',
        'services',
        'patient_merges',
        'outbox',
        'patients',
      ]) {
        await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await deleteUsers(pool, [admin, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('claims and a patient merge', () => {
  it('moves open claims, leaves sent ones, finds them from the survivor and gives back on unmerge', async () => {
    const source = await newPatient();
    const target = await newPatient();
    await cover(source, hospital, admin);
    await cover(target, hospital, admin);
    const draft = await claimFor(source);
    const sent = await claimFor(source);
    const own = await claimFor(target);
    const proof = await document(source);
    for (const id of [draft, sent]) {
      await ok(await post(`/claims/${id}/files`, { documentId: proof }), 201);
    }
    // One claim was already decided by the payer.
    await pool.query(
      `update claims set status = 'approved', approved_minor = 100000, decided_at = now() where id = $1`,
      [sent],
    );

    await ok(await merge(source, target), 201);
    expect(await patientOf(draft)).toBe(target);
    expect(await patientOf(sent)).toBe(source);
    expect(await patientOf(own)).toBe(target);

    // The survivor's claims include the one that stayed on the old record, and nobody else's.
    const list = await ok<{ items: { id: string }[] }>(await get(`/claims?patientId=${target}`));
    expect(list.items.map((c) => c.id).sort()).toEqual([draft, sent, own].sort());
    const sourceOnly = await ok<{ items: { id: string }[] }>(
      await get(`/claims?patientId=${source}`),
    );
    expect(sourceOnly.items.map((c) => c.id)).toEqual([sent]);

    // A packet never holds a file of a record other than its claim's (the survivor counts as one
    // with the record merged into it).
    const stray = await pool.query(
      `select cd.claim_id from claim_documents cd
         join claims c on c.tenant_id = cd.tenant_id and c.id = cd.claim_id
         join patient_documents d on d.tenant_id = cd.tenant_id and d.id = cd.document_id
         join patients cp on cp.id = c.patient_id
         join patients dp on dp.id = d.patient_id
        where coalesce(cp.merged_into_id, cp.id) <> coalesce(dp.merged_into_id, dp.id)`,
    );
    expect(stray.rows).toEqual([]);
    const strict = await pool.query(
      `select cd.claim_id from claim_documents cd
         join claims c on c.id = cd.claim_id join patient_documents d on d.id = cd.document_id
        where c.status in ('draft', 'submitted', 'query') and c.patient_id <> d.patient_id`,
    );
    expect(strict.rows).toEqual([]);

    // A claim made after the merge for the survivor stays with it on unmerge.
    const later = await claimFor(target);
    await ok(await post(`/patients/${source}/unmerge`, { reason: 'Different people' }));
    expect(await patientOf(draft)).toBe(source);
    expect(await patientOf(sent)).toBe(source);
    expect(await patientOf(own)).toBe(target);
    expect(await patientOf(later)).toBe(target);
    const mine = await ok<{ items: { id: string }[] }>(await get(`/claims?patientId=${source}`));
    expect(mine.items.map((c) => c.id).sort()).toEqual([draft, sent].sort());
  });

  it('only a merge moves a claim', async () => {
    const one1 = await newPatient();
    const two = await newPatient();
    await cover(one1, hospital, admin);
    const id = await claimFor(one1);
    await expect(
      pool.query('update claims set patient_id = $2 where id = $1', [id, two]),
    ).rejects.toThrow(/merged/);
  });

  it('does not show another hospital a patient or its claims', async () => {
    const outsider = await newPatient(clinic);
    const response = await get(`/claims?patientId=${outsider}`);
    expect(response.statusCode).toBe(404);
  });
});
