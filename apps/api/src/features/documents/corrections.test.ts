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

/** Requests to correct a record (#556): author and reason, a second person decides, once. */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let noRecords: TestTenant;
let admin: TestUser;
let receptionist: TestUser;
let pharmacist: TestUser;
let clinicAdmin: TestUser;
let noRecordsAdmin: TestUser;
const ids = { patient: '', other: '', clinicPatient: '', noRecordsPatient: '', doc: '' };

interface Request {
  id: string;
  status: string;
  version: number;
  requestedBy: string;
  decidedBy?: string;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers(options), 'idempotency-key': randomUUID() },
    payload: body,
  });
const errorOf = (reply: { statusCode: number; json: () => { error: { code: string } } }) => [
  reply.statusCode,
  reply.json().error.code,
];
const ask = (patientId: string, body: object = {}, options: Options = { user: receptionist }) =>
  post(
    `/patients/${patientId}/correction-requests`,
    {
      targetKind: 'patient',
      proposed: 'Date of birth should be 1981-02-03',
      reason: 'Wrong year typed at registration',
      ...body,
    },
    options,
  );
const decide = async (id: string, path: 'approve' | 'reject', options: Options = {}) => {
  const current = (await get('/correction-requests?limit=100', options))
    .json<{ items: Request[] }>()
    .items.find((item) => item.id === id);
  return post(
    `/correction-requests/${id}/${path}`,
    { reason: 'Checked against the ID card', expectedVersion: current?.version ?? 1 },
    options,
  );
};
const actions = async (id: string) =>
  (
    await pool.query<{ action: string }>(
      "select action from audit_log where entity = 'record_correction_request' and entity_id = $1 order by at",
      [id],
    )
  ).rows.map((row) => row.action);

async function patient(tenant: TestTenant, mrn: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Corr', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, mrn],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const on = { patients: true, documents: true, records: true };
  hospital = await createTenant(pool, 'Correction Hospital', { features: on });
  clinic = await createTenant(pool, 'Correction Clinic', { features: on });
  noRecords = await createTenant(pool, 'Correction Bare', {
    features: { patients: true, documents: true },
  });
  for (const tenant of [hospital, clinic, noRecords]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Correction Admin');
  receptionist = await user('Correction Receptionist');
  pharmacist = await user('Correction Pharmacist');
  clinicAdmin = await user('Correction Clinic Admin');
  noRecordsAdmin = await user('Correction Bare Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, noRecordsAdmin, noRecords, 'admin');
  ids.patient = await patient(hospital, 'CR-0000001');
  ids.other = await patient(hospital, 'CR-0000002');
  ids.clinicPatient = await patient(clinic, 'CR-0000001');
  ids.noRecordsPatient = await patient(noRecords, 'CR-0000001');
  const doc = await pool.query<{ id: string }>(
    `insert into patient_documents (tenant_id, patient_id, category, title, file_name, content_type,
       size_bytes, status, created_by)
     values ($1, $2, 'other', 'Scan', 'scan.pdf', 'application/pdf', 10, 'pending', $3) returning id`,
    [hospital.id, ids.patient, admin.id],
  );
  ids.doc = doc.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const tenants = [hospital.id, clinic.id, noRecords.id];
    for (const table of ['record_correction_requests', 'patient_documents', 'outbox', 'patients']) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, receptionist, pharmacist, clinicAdmin, noRecordsAdmin]);
  await deleteTenants(pool, [hospital, clinic, noRecords]);
  await app.close();
});

describe('asking for a correction', () => {
  it('records the author and reason, audits it, and edits nothing', async () => {
    const reply = await ask(ids.patient);
    expect(reply.statusCode).toBe(201);
    const request = reply.json<Request>();
    expect(request).toMatchObject({ status: 'pending', requestedBy: receptionist.id, version: 1 });
    expect(await actions(request.id)).toEqual(['create']);
    const dob = await pool.query('select dob::text from patients where id = $1', [ids.patient]);
    expect(dob.rows[0].dob).toBe('1980-05-01');
  });

  it('takes a document of the patient, and refuses one that is not theirs', async () => {
    expect((await ask(ids.patient, { targetKind: 'document', targetId: ids.doc })).statusCode).toBe(
      201,
    );
    expect(errorOf(await ask(ids.other, { targetKind: 'document', targetId: ids.doc }))).toEqual([
      422,
      'target_mismatch',
    ]);
    expect(errorOf(await ask(ids.patient, { targetKind: 'encounter' }))).toEqual([
      422,
      'target_mismatch',
    ]);
  });

  it('needs a reason and what to change', async () => {
    expect((await ask(ids.patient, { reason: '' })).statusCode).toBe(400);
    expect((await ask(ids.patient, { proposed: ' ' })).statusCode).toBe(400);
  });

  it('is refused without the permission, with the module off, and across hospitals', async () => {
    expect((await ask(ids.patient, {}, { user: pharmacist })).statusCode).toBe(403);
    expect(
      (await ask(ids.noRecordsPatient, {}, { tenant: noRecords, user: noRecordsAdmin })).statusCode,
    ).toBe(403);
    expect((await ask(ids.clinicPatient, {}, { user: receptionist })).statusCode).toBe(404);
  });
});

describe('listing', () => {
  it('lists a patient’s requests and the hospital’s pending ones, by cursor', async () => {
    const mine = await get(`/patients/${ids.patient}/correction-requests`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(2);
    const page = await get('/correction-requests?limit=1&status=pending');
    const body = page.json<{ items: Request[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    const next = await get(`/correction-requests?limit=1&cursor=${body.nextCursor}`);
    expect(next.json<{ items: Request[] }>().items[0]!.id).not.toBe(body.items[0]!.id);
  });

  it('shows nothing of another hospital', async () => {
    const other = await get('/correction-requests', { tenant: clinic, user: clinicAdmin });
    expect(other.json<{ items: unknown[] }>().items).toEqual([]);
    const foreign = await get(`/patients/${ids.patient}/correction-requests`, {
      tenant: clinic,
      user: clinicAdmin,
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('deciding', () => {
  it('approves once, with a reason, by a second person', async () => {
    const request = (await ask(ids.patient)).json<Request>();
    const approved = await decide(request.id, 'approve');
    expect(approved.statusCode).toBe(200);
    expect(approved.json<Request>()).toMatchObject({ status: 'approved', decidedBy: admin.id });
    expect(await actions(request.id)).toEqual(['create', 'read', 'update']);
    expect(errorOf(await decide(request.id, 'reject'))).toEqual([409, 'already_decided']);
  });

  it('rejects with a reason', async () => {
    const request = (await ask(ids.patient)).json<Request>();
    expect((await decide(request.id, 'reject')).json<Request>().status).toBe('rejected');
  });

  it('never lets the author decide their own request', async () => {
    const request = (await ask(ids.patient, {}, { user: admin })).json<Request>();
    expect(errorOf(await decide(request.id, 'approve'))).toEqual([403, 'second_person_required']);
  });

  it('is refused to a role without correction:decide', async () => {
    const request = (await ask(ids.patient)).json<Request>();
    const reply = await post(
      `/correction-requests/${request.id}/approve`,
      { reason: 'ok', expectedVersion: 1 },
      { user: receptionist },
    );
    expect(reply.statusCode).toBe(403);
  });

  it('refuses a stale version and another hospital’s request', async () => {
    const request = (await ask(ids.patient)).json<Request>();
    const stale = await post(`/correction-requests/${request.id}/approve`, {
      reason: 'ok',
      expectedVersion: 9,
    });
    expect(errorOf(stale)).toEqual([409, 'conflict']);
    const foreign = await post(
      `/correction-requests/${request.id}/approve`,
      { reason: 'ok', expectedVersion: 1 },
      { tenant: clinic, user: clinicAdmin },
    );
    expect(foreign.statusCode).toBe(404);
  });
});
