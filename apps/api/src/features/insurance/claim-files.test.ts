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

/** The files of a claim's packet (#976): links to the patient's documents. */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let noDocs: TestTenant;
let admin: TestUser;
let receptionist: TestUser;
let clinicAdmin: TestUser;
let docsOffAdmin: TestUser;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
interface Files {
  items: { documentId: string; title: string; status: string; retired: boolean }[];
}
let keys = 0;
const headers = (options: Options = {}, key = false) => ({
  ...as((options.tenant ?? hospital).id, (options.user ?? admin).id),
  ...(key ? { 'idempotency-key': `cf-key-${String(++keys).padStart(6, '0')}` } : {}),
});
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, payload: object, options: Options = {}) =>
  app.inject({ method: 'POST', url, headers: headers(options, true), payload });
const del = (url: string, options: Options = {}) =>
  app.inject({ method: 'DELETE', url, headers: headers(options) });
const errorOf = (response: Response) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
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
/** A patient with a visit, cover and a draft claim for a tenant. */
async function claim(tenant: TestTenant = hospital, user: TestUser = admin) {
  const patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Cf', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CF-${String(++mrn).padStart(7, '0')}`],
  );
  const encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [tenant.id, patientId, user.id],
  );
  const serviceId = await one(
    `insert into services (tenant_id, code, name, category, tax_class) values ($1, $2, 'Cf Service', 'procedure', 'exempt') returning id`,
    [tenant.id, `CFS-${++codes}`],
  );
  await pool.query(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor)
     values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, 100000)`,
    [tenant.id, encounterId, patientId, serviceId, `cf-test:${++keys}`],
  );
  const options = { tenant, user };
  const org = await ok<{ id: string }>(
    await post(
      '/payers',
      { kind: 'insurer', code: `CFP${++codes}`, name: `Cf Payer ${codes}` },
      options,
    ),
    201,
  );
  const plan = await ok<{ id: string }>(
    await post(
      `/payers/${org.id}/plans`,
      {
        code: `CFPL${++codes}`,
        name: `Cf Plan ${codes}`,
        coverageMode: 'all_except',
        copayPercent: 0,
        preAuthRequired: false,
        services: [],
      },
      options,
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
      options,
    ),
    201,
  );
  const made = await ok<{ id: string }>(
    await post(`/encounters/${encounterId}/claims`, { documents: [] }, options),
    201,
  );
  return { claimId: made.id, patientId };
}

async function document(patientId: string, { status = 'clean', retired = false } = {}) {
  return one(
    `insert into patient_documents (tenant_id, patient_id, category, title, file_name, content_type,
       size_bytes, status, uploaded_at, created_by, retired_at, retired_by, retired_reason)
     values ($1, $2, 'insurance', 'Discharge summary', 'dc.pdf', 'application/pdf', 1000, $3,
       case when $3 = 'pending' then null else now() end, $4,
       case when $5 then now() end, case when $5 then $4::uuid end, case when $5 then 'Replaced' end)
     returning id`,
    [hospital.id, patientId, status, admin.id, retired],
  );
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const on = { insurance: true, patients: true, billing: true, documents: true };
  hospital = await createTenant(pool, 'Cf Hospital', { features: on });
  clinic = await createTenant(pool, 'Cf Clinic', { features: on });
  noDocs = await createTenant(pool, 'Cf No Docs', { features: { ...on, documents: false } });
  for (const tenant of [hospital, clinic, noDocs]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Cf Admin', { withPassword: false });
  receptionist = await createUser(pool, 'Cf Desk', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Cf Clinic Admin', { withPassword: false });
  docsOffAdmin = await createUser(pool, 'Cf Docs Off Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, docsOffAdmin, noDocs, 'admin');
}, 60_000);

afterAll(async () => {
  try {
    const tenants = [hospital, clinic, noDocs].filter(Boolean).map((tenant) => tenant.id);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      for (const table of [
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
    await deleteUsers(pool, [admin, receptionist, clinicAdmin, docsOffAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, noDocs].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('claim packet files', () => {
  it('attaches, lists and detaches a clean document, audited', async () => {
    const { claimId, patientId } = await claim();
    const documentId = await document(patientId);
    expect((await ok<Files>(await get(`/claims/${claimId}/files`))).items).toEqual([]);
    const attached = await ok<Files>(await post(`/claims/${claimId}/files`, { documentId }), 201);
    expect(attached.items).toEqual([
      expect.objectContaining({ documentId, title: 'Discharge summary', status: 'clean' }),
    ]);
    expect(errorOf(await post(`/claims/${claimId}/files`, { documentId }))).toEqual([
      409,
      'already_attached',
    ]);
    expect((await ok<Files>(await get(`/claims/${claimId}/files`))).items).toHaveLength(1);
    expect((await ok<Files>(await del(`/claims/${claimId}/files/${documentId}`))).items).toEqual(
      [],
    );
    expect(errorOf(await del(`/claims/${claimId}/files/${documentId}`))).toEqual([
      404,
      'document_not_found',
    ]);
    const { rows } = await pool.query<{ detail: string | null }>(
      `select detail from audit_log where tenant_id = $1 and entity = 'claim'
         and entity_id = $2 and (detail like 'attach:%' or detail like 'detach:%') order by at`,
      [hospital.id, claimId],
    );
    expect(rows.map((row) => row.detail)).toEqual([`attach:${documentId}`, `detach:${documentId}`]);
  });

  it('refuses a document that is not ready, retired, another patient’s or unknown', async () => {
    const { claimId, patientId } = await claim();
    const other = await claim();
    const url = `/claims/${claimId}/files`;
    const attempt = async (documentId: string) => errorOf(await post(url, { documentId }));
    expect(await attempt(await document(patientId, { status: 'scanning' }))).toEqual([
      409,
      'document_not_ready',
    ]);
    expect(await attempt(await document(patientId, { retired: true }))).toEqual([
      409,
      'document_retired',
    ]);
    expect(await attempt(await document(other.patientId))).toEqual([404, 'document_not_found']);
    expect(await attempt('00000000-0000-4000-8000-000000000000')).toEqual([
      404,
      'document_not_found',
    ]);
  });

  it('holds at most 20 files and none once the claim is closed', async () => {
    const { claimId, patientId } = await claim();
    const url = `/claims/${claimId}/files`;
    for (let n = 0; n < 20; n++) {
      await ok(await post(url, { documentId: await document(patientId) }), 201);
    }
    expect(errorOf(await post(url, { documentId: await document(patientId) }))).toEqual([
      422,
      'packet_full',
    ]);
    await pool.query("update claims set status = 'cancelled' where id = $1", [claimId]);
    const [first] = (await ok<Files>(await get(url))).items;
    expect(errorOf(await del(`${url}/${first?.documentId}`))).toEqual([409, 'claim_closed']);
    expect(errorOf(await post(url, { documentId: await document(patientId) }))).toEqual([
      409,
      'claim_closed',
    ]);
  });

  it('leaves an OPD sheet out for a caller who may not read it (#1200)', async () => {
    const { claimId, patientId } = await claim();
    const visit = await one('select id from encounters where patient_id = $1', [patientId]);
    const sheet = await document(patientId);
    await pool.query(
      "update patient_documents set category = 'opd_sheet', encounter_id = $2 where id = $1",
      [sheet, visit],
    );
    const url = `/claims/${claimId}/files`;
    await ok(await post(url, { documentId: sheet }), 201);
    // The desk reads claims and documents but not diagnoses.
    expect((await ok<Files>(await get(url, { user: receptionist }))).items).toEqual([]);
    const restrict = (scope: string) =>
      pool.query(
        `update role_permissions set scope = $2
         where tenant_id = $1 and permission = 'diagnosis:read' and role_id = 'admin'`,
        [hospital.id, scope],
      );
    // The visit has no attending doctor, so it is nobody's own.
    await restrict('own');
    try {
      expect(errorOf(await del(`${url}/${sheet}`))).toEqual([404, 'document_not_found']);
      expect(errorOf(await post(url, { documentId: sheet }))).toEqual([404, 'document_not_found']);
    } finally {
      await restrict('all');
    }
    expect((await ok<Files>(await get(url))).items).toHaveLength(1);
  });

  it('keeps hospitals apart and follows the documents switch', async () => {
    const { claimId, patientId } = await claim();
    const documentId = await document(patientId);
    await ok(await post(`/claims/${claimId}/files`, { documentId }), 201);
    const url = `/claims/${claimId}/files`;
    const outsider = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(url, outsider))[1]).toBe('claim_not_found');
    expect(errorOf(await post(url, { documentId }, outsider))[1]).toBe('claim_not_found');
    expect(errorOf(await del(`${url}/${documentId}`, outsider))[1]).toBe('claim_not_found');
    expect((await get(url, { user: receptionist })).statusCode).toBe(200);
    const off = await claim(noDocs, docsOffAdmin);
    expect(
      errorOf(await get(`/claims/${off.claimId}/files`, { tenant: noDocs, user: docsOffAdmin })),
    ).toEqual([403, 'feature_disabled']);
  });
});
