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
  hospitalDay,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { renderPdf } from './pdf.js';

/** Consents and certificates kept as rendered documents (#990). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let receptionist: TestUser;
let clinicAdmin: TestUser;
let patientId = '';
let templateId = '';

const headers = (tenant: TestTenant, user: TestUser) => as(tenant.id, user.id);
const post = (url: string, body?: object, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers(tenant, user), 'idempotency-key': randomUUID() },
    ...(body ? { payload: body } : {}),
  });
const errorOf = (reply: { statusCode: number; json: () => { error: { code: string } } }) => [
  reply.statusCode,
  reply.json().error.code,
];
const text = (value: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});

interface Doc {
  id: string;
  patientId: string;
  category: string;
  status: string;
  contentType: string;
  fileName: string;
  size: number;
  retainUntil?: string;
}

async function signConsent(patient = patientId) {
  const reply = await post(`/patients/${patient}/consents`, {
    templateId,
    templateVersion: 1,
    procedureName: 'Appendicectomy (surgery)',
    body: text('I agree to the procedure. Naïve (test) \\ text.'),
    signerName: 'Asha Rao',
    signerRole: 'patient',
    signatureMethod: 'drawn',
    signature: 'M 10 10 L 50 40 L 90 20',
  });
  expect(reply.statusCode).toBe(201);
  return reply.json<{ consent: { id: string } }>().consent.id;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const on = { patients: true, consents: true, templates: true, documents: true };
  hospital = await createTenant(pool, 'Rendered Hospital', { features: on });
  clinic = await createTenant(pool, 'Rendered Clinic', { features: on });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Rendered Admin');
  receptionist = await user('Rendered Storekeeper');
  clinicAdmin = await user('Rendered Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, receptionist, hospital, 'store_keeper');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
  patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, 'RD-0000001', 'Rendered', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test')
     returning id`,
    [hospital.id],
  );
  templateId = await one(
    `insert into templates (tenant_id, kind, name) values ($1, 'consent', 'Surgery consent') returning id`,
    [hospital.id],
  );
  await pool.query(
    `insert into template_versions (tenant_id, template_id, version, name, body, saved_by)
     values ($1, $2, 1, 'Surgery consent', '{"type":"doc","content":[]}', $3)`,
    [hospital.id, templateId, admin.id],
  );
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const tenants = [hospital.id, clinic.id];
    for (const table of [
      'patient_documents',
      'consent_witnesses',
      'consent_withdrawals',
      'patient_consents',
      'patient_certificates',
      'certificate_counters',
      'template_versions',
      'templates',
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
  await deleteUsers(pool, [admin, receptionist, clinicAdmin]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

describe('renderPdf', () => {
  it('writes a PDF with a table of its objects, escaping and wrapping text', () => {
    const pdf = renderPdf('T', [
      { kind: 'title', text: 'A (title) \\ with ünïcode and हिन्दी' },
      { kind: 'text', text: 'word '.repeat(2000) },
      { kind: 'signature', path: 'M 0 0 L 300 150' },
    ]);
    const source = pdf.toString('latin1');
    expect(source.startsWith('%PDF-')).toBe(true);
    expect(source.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(source).toContain('A \\(title\\) \\\\ with');
    expect(source).toMatch(/\/Count [2-9]/);
    const start = Number(/startxref\n(\d+)/.exec(source)![1]);
    expect(source.slice(start, start + 4)).toBe('xref');
  });
});

describe('a consent kept as a document', () => {
  it('renders the PDF, stores it clean on the record and returns the same document again', async () => {
    const consentId = await signConsent();
    const first = await post(`/consents/${consentId}/document`);
    expect(first.statusCode).toBe(200);
    const doc = first.json<Doc>();
    expect(doc).toMatchObject({
      patientId,
      category: 'consent',
      status: 'clean',
      contentType: 'application/pdf',
    });
    const { rows } = await pool.query<{ file_key: string; source_consent_id: string }>(
      'select file_key, source_consent_id from patient_documents where id = $1',
      [doc.id],
    );
    expect(rows[0]!.source_consent_id).toBe(consentId);
    const file = await app.files.get(rows[0]!.file_key);
    expect(file!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file!.length).toBe(doc.size);

    const again = await post(`/consents/${consentId}/document`);
    expect(again.json<Doc>().id).toBe(doc.id);
    const count = await pool.query('select 1 from patient_documents where source_consent_id = $1', [
      consentId,
    ]);
    expect(count.rowCount).toBe(1);

    const listed = await app.inject({
      url: `/patients/${patientId}/documents`,
      headers: headers(hospital, admin),
    });
    expect(listed.json<{ items: Doc[] }>().items.map((item) => item.id)).toContain(doc.id);
  });

  it('is one 404 for another hospital and a 403 without the permissions', async () => {
    const consentId = await signConsent();
    expect(
      errorOf(await post(`/consents/${consentId}/document`, undefined, clinic, clinicAdmin)),
    ).toEqual([404, 'not_found']);
    const denied = await post(`/consents/${consentId}/document`, undefined, hospital, receptionist);
    expect(denied.statusCode).toBe(403);
  });
});

describe('a certificate kept as a document', () => {
  it('renders the PDF once for the certificate', async () => {
    const issued = await post(`/patients/${patientId}/certificates`, {
      kind: 'medical',
      issuedOn: hospitalDay(0),
      fields: { diagnosis: 'Viral fever', restFrom: hospitalDay(0), restTo: hospitalDay(2) },
    });
    expect(issued.statusCode).toBe(201);
    const id = issued.json<{ id: string }>().id;
    const first = await post(`/certificates/${id}/document`);
    expect(first.statusCode).toBe(200);
    expect(first.json<Doc>()).toMatchObject({ category: 'certificate', status: 'clean' });
    const second = await post(`/certificates/${id}/document`);
    expect(second.json<Doc>().id).toBe(first.json<Doc>().id);
    expect(errorOf(await post(`/certificates/${randomUUID()}/document`))).toEqual([
      404,
      'not_found',
    ]);
  });
});
