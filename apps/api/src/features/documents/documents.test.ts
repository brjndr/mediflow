import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileStore } from '../../core/files/store.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
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
import { sweepDocuments } from './files.js';

/**
 * Patient documents and the merge of two patient records (#194) through the real app and
 * database: the signed upload, the malware scan, the download link, retention and its sweep,
 * retiring, the merge (atomic, audited, documents moved) and the hospital boundary.
 */

class MemoryStore implements FileStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

const store = new MemoryStore();
const queue = new MemoryQueue();
let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;
let receptionist: TestUser;
let pharmacist: TestUser;
const ids = { a: '', b: '', c: '', clinicPatient: '' };
let failMerge = false;

interface Upload {
  document: { id: string; status: string; retainUntil?: string; version: number };
  uploadUrl: string;
}
interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
type Reply = { statusCode: number; json: () => { error: { code: string } } };

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const EICAR = Buffer.from(
  '%PDF-1.4\n' + 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' + '\n',
);

const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const send = (
  method: 'POST' | 'PUT',
  url: string,
  body: object,
  options: Options = {},
  key = randomUUID(),
) =>
  app.inject({
    method,
    url,
    headers: { ...headers(options), 'idempotency-key': key },
    payload: body,
  });
const post = (url: string, body: object, options: Options = {}, key = randomUUID()) =>
  send('POST', url, body, options, key);
const put = (url: string, data: Buffer, contentType: string) =>
  app.inject({ method: 'PUT', url, headers: { 'content-type': contentType }, payload: data });
const errorOf = (reply: Reply) => [reply.statusCode, reply.json().error.code];

const ask = (patientId: string, body: object = {}, options: Options = {}) =>
  post(
    `/patients/${patientId}/documents`,
    {
      category: 'outside_report',
      title: 'Blood report',
      fileName: 'report.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
      ...body,
    },
    options,
  );

async function uploaded(patientId: string, data = PDF, body: object = {}, options: Options = {}) {
  const asked = await ask(patientId, { size: data.length, ...body }, options);
  expect(asked.statusCode).toBe(201);
  const upload = asked.json<Upload>();
  expect((await put(upload.uploadUrl, data, 'application/pdf')).statusCode).toBe(204);
  return upload;
}

const statusOf = async (id: string) =>
  (await pool.query<{ status: string }>('select status from patient_documents where id = $1', [id]))
    .rows[0]?.status;
const actions = async (entity: string, id: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where entity = $1 and entity_id = $2 order by at',
      [entity, id],
    )
  ).rows.map((row) => row.action);
const versionOf = async (id: string) =>
  (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
    .rows[0]!.version;

const merge = async (
  target: string,
  source: string,
  options: Options = {},
  reason = 'Duplicate registration',
) =>
  post(
    `/patients/${target}/merge`,
    {
      sourcePatientId: source,
      reason,
      expectedVersion: await versionOf(target),
      expectedSourceVersion: await versionOf(source),
    },
    options,
  );

async function patient(tenant: TestTenant, mrn: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Doc', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, mrn],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    fileStore: store,
    jobQueue: queue,
  });
  app.patientMerge.register('failing_test', async () => {
    if (failMerge) throw new Error('module could not move its rows');
    return 0;
  });
  pool = app.database.pool;
  const features = { patients: true, documents: true };
  hospital = await createTenant(pool, 'Documents Hospital', { features });
  clinic = await createTenant(pool, 'Documents Clinic', { features });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Documents Admin');
  clinicAdmin = await user('Documents Clinic Admin');
  receptionist = await user('Documents Receptionist');
  pharmacist = await user('Documents Pharmacist');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, pharmacist, hospital, 'pharmacist');
  ids.a = await patient(hospital, 'DC-0000001');
  ids.b = await patient(hospital, 'DC-0000002');
  ids.c = await patient(hospital, 'DC-0000003');
  ids.clinicPatient = await patient(clinic, 'DC-0000001');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'patient_documents',
      'patient_merges',
      'document_retention_rules',
      'outbox',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, clinicAdmin, receptionist, pharmacist]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

describe('asking for an upload', () => {
  it('gives a signed link and audits it', async () => {
    const asked = await ask(ids.a);
    expect(asked.statusCode).toBe(201);
    const upload = asked.json<Upload>();
    expect(upload.document).toMatchObject({ status: 'pending' });
    expect(upload.document.retainUntil).toBeUndefined();
    expect(upload.uploadUrl).toMatch(/^\/document-uploads\/[0-9a-f-]+\?expires=\d+&signature=/);
    expect(await actions('patient_document', upload.document.id)).toEqual(['create']);
  });

  it('answers the same for the same idempotency key', async () => {
    const key = randomUUID();
    const body = {
      category: 'consent',
      title: 'Consent',
      fileName: 'c.pdf',
      contentType: 'application/pdf',
      size: 10,
    };
    const first = (await post(`/patients/${ids.a}/documents`, body, {}, key)).json<Upload>();
    const again = await post(`/patients/${ids.a}/documents`, body, {}, key);
    expect(again.statusCode).toBe(201);
    expect(again.json<Upload>().document.id).toBe(first.document.id);
  });

  it('refuses a large file, another type, an encounter of another patient and a merged record', async () => {
    expect(errorOf(await ask(ids.a, { size: 26 * 1024 * 1024 }))).toEqual([422, 'file_too_large']);
    expect(errorOf(await ask(ids.a, { contentType: 'application/x-msdownload' }))).toEqual([
      422,
      'file_type_not_allowed',
    ]);
    expect((await ask(ids.a, { size: 0 })).statusCode).toBe(400);
    expect(errorOf(await ask(ids.a, { encounterId: randomUUID() }))).toEqual([
      422,
      'encounter_mismatch',
    ]);
  });

  it('needs document:upload, and another hospital sees nothing', async () => {
    expect(errorOf(await ask(ids.a, {}, { user: pharmacist }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await ask(ids.a, {}, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'not_found',
    ]);
    expect((await ask(ids.a, {}, { user: receptionist })).statusCode).toBe(201);
  });
});

describe('receiving the file and the scan', () => {
  it('holds a file until the scan clears it, then serves it by a signed link', async () => {
    const upload = await uploaded(ids.a);
    const id = upload.document.id;
    expect(await statusOf(id)).toBe('scanning');
    expect(errorOf(await get(`/documents/${id}/download-url`))).toEqual([
      409,
      'document_not_ready',
    ]);

    await queue.drain();
    expect(await statusOf(id)).toBe('clean');
    const link = (await get(`/documents/${id}/download-url`)).json<{ url: string }>();
    const file = await app.inject({ url: link.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-disposition'])).toContain('attachment');
    expect(await actions('patient_document', id)).toContain('export');

    // Another hospital's admin cannot even ask for a link.
    const other = await get(`/documents/${id}/download-url`, { tenant: clinic, user: clinicAdmin });
    expect(errorOf(other)).toEqual([404, 'document_not_found']);
  });

  it('blocks and deletes an infected file', async () => {
    const upload = await uploaded(ids.a, EICAR);
    await queue.drain();
    const id = upload.document.id;
    expect(await statusOf(id)).toBe('infected');
    const row = await pool.query<{ file_key: string }>(
      'select file_key from patient_documents where id = $1',
      [id],
    );
    expect(await store.get(row.rows[0]?.file_key ?? '')).toBeNull();
    expect(errorOf(await get(`/documents/${id}/download-url`))).toEqual([409, 'document_blocked']);
  });

  it('refuses a wrong size, a wrong type, a forged link and a second use', async () => {
    const asked = (await ask(ids.a, { size: PDF.length })).json<Upload>();
    const wrongSize = await put(asked.uploadUrl, Buffer.concat([PDF, PDF]), 'application/pdf');
    expect(errorOf(wrongSize)).toEqual([400, 'size_mismatch']);
    const wrongType = await put(asked.uploadUrl, Buffer.alloc(PDF.length, 1), 'application/pdf');
    expect(errorOf(wrongType)).toEqual([415, 'file_type_mismatch']);
    expect((await put(asked.uploadUrl, PDF, 'image/png')).statusCode).toBe(415);
    const forged = asked.uploadUrl.replace(/signature=.*$/, 'signature=forged');
    expect(errorOf(await put(forged, PDF, 'application/pdf'))).toEqual([
      404,
      'document_file_not_found',
    ]);
    expect((await put(asked.uploadUrl, PDF, 'application/pdf')).statusCode).toBe(204);
    expect(errorOf(await put(asked.uploadUrl, PDF, 'application/pdf'))).toEqual([
      404,
      'document_file_not_found',
    ]);
  });
});

describe('the list and retiring', () => {
  it('lists newest first with a cursor, and hides retired documents by default', async () => {
    const patientId = await patient(hospital, 'DC-0000010');
    const first = await uploaded(patientId);
    const second = await uploaded(patientId, PDF, { category: 'consent' });
    const third = await uploaded(patientId, PDF, { category: 'consent' });
    const page = (await get(`/patients/${patientId}/documents?limit=2`)).json<{
      items: { id: string }[];
      nextCursor: string | null;
    }>();
    expect(page.items.map((item) => item.id)).toEqual([third.document.id, second.document.id]);
    const next = (
      await get(`/patients/${patientId}/documents?limit=2&cursor=${page.nextCursor}`)
    ).json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(next.items.map((item) => item.id)).toEqual([first.document.id]);
    expect(next.nextCursor).toBeNull();
    const consents = (await get(`/patients/${patientId}/documents?category=consent`)).json<{
      items: unknown[];
    }>();
    expect(consents.items).toHaveLength(2);

    const retired = await post(`/documents/${second.document.id}/retire`, {
      reason: 'Attached to the wrong patient',
      expectedVersion: 1,
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toMatchObject({
      retiredReason: 'Attached to the wrong patient',
      version: 2,
    });
    const visible = (await get(`/patients/${patientId}/documents`)).json<{ items: unknown[] }>();
    expect(visible.items).toHaveLength(2);
    const all = (await get(`/patients/${patientId}/documents?includeRetired=true`)).json<{
      items: unknown[];
    }>();
    expect(all.items).toHaveLength(3);
    // Retired, it is still on the record and can be downloaded.
    await queue.drain();
    expect((await get(`/documents/${second.document.id}/download-url`)).statusCode).toBe(200);
  });

  it('retires once, at the version read, and only with document:retire', async () => {
    const upload = await uploaded(ids.a);
    const id = upload.document.id;
    const body = { reason: 'Replaced', expectedVersion: 1 };
    expect(errorOf(await post(`/documents/${id}/retire`, body, { user: receptionist }))).toEqual([
      403,
      'permission_denied',
    ]);
    expect(errorOf(await post(`/documents/${id}/retire`, { ...body, expectedVersion: 5 }))).toEqual(
      [409, 'conflict'],
    );
    expect((await post(`/documents/${id}/retire`, body)).statusCode).toBe(200);
    expect(errorOf(await post(`/documents/${id}/retire`, { ...body, expectedVersion: 2 }))).toEqual(
      [409, 'already_retired'],
    );
    expect(
      errorOf(await post(`/documents/${id}/retire`, body, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'document_not_found']);
  });

  it('never lets the app delete a document or change its file', async () => {
    const upload = await uploaded(ids.a);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_app');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', hospital.id]);
      await expect(
        client.query('delete from patient_documents where id = $1', [upload.document.id]),
      ).rejects.toThrow();
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role mediflow_app');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', hospital.id]);
      await expect(
        client.query("update patient_documents set status = 'clean' where id = $1", [
          upload.document.id,
        ]),
      ).rejects.toThrow();
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

describe('retention', () => {
  it('sets, lists and clears a rule, with the right permissions', async () => {
    const before = (await get('/document-retention')).json<{
      items: { category: string; years: number | null }[];
    }>();
    expect(before.items.find((rule) => rule.category === 'consent')?.years).toBeNull();
    const set = await app.inject({
      method: 'PUT',
      url: '/document-retention/consent',
      headers: headers(),
      payload: { years: 7 },
    });
    expect(set.json()).toEqual({ category: 'consent', years: 7 });
    const after = (await get('/document-retention')).json<{
      items: { category: string; years: number | null }[];
    }>();
    expect(after.items.find((rule) => rule.category === 'consent')?.years).toBe(7);
    expect(after.items).toHaveLength(7);

    const denied = await app.inject({
      method: 'PUT',
      url: '/document-retention/consent',
      headers: headers({ user: receptionist }),
      payload: { years: 1 },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (await get('/document-retention', { tenant: clinic, user: clinicAdmin }))
        .json<{ items: { years: number | null }[] }>()
        .items.every((rule) => rule.years === null),
    ).toBe(true);

    const cleared = await app.inject({
      method: 'PUT',
      url: '/document-retention/consent',
      headers: headers(),
      payload: { years: null },
    });
    expect(cleared.json()).toEqual({ category: 'consent', years: null });
  });

  it('dates a document from the rule at the time, and the sweep removes only what is past it', async () => {
    await app.inject({
      method: 'PUT',
      url: '/document-retention/certificate',
      headers: headers(),
      payload: { years: 3 },
    });
    const kept = await uploaded(ids.a, PDF, { category: 'certificate' });
    const forever = await uploaded(ids.a, PDF, { category: 'other' });
    const due = await uploaded(ids.a, PDF, { category: 'certificate' });
    await queue.drain();
    expect(kept.document.retainUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(forever.document.retainUntil).toBeUndefined();

    // The rule changing later does not shorten a document already kept.
    await app.inject({
      method: 'PUT',
      url: '/document-retention/certificate',
      headers: headers(),
      payload: { years: 1 },
    });
    const same = await pool.query<{ retain_until: string }>(
      'select retain_until::text from patient_documents where id = $1',
      [kept.document.id],
    );
    expect(same.rows[0]?.retain_until).toBe(kept.document.retainUntil);

    // Time passes for one of them.
    await pool.query('update patient_documents set retain_until = current_date - 1 where id = $1', [
      due.document.id,
    ]);
    const key = (
      await pool.query<{ file_key: string }>(
        'select file_key from patient_documents where id = $1',
        [due.document.id],
      )
    ).rows[0]!.file_key;
    expect(await store.get(key)).not.toBeNull();

    expect(await sweepDocuments(app)).toEqual([]);
    expect(await statusOf(due.document.id)).toBe('purged');
    expect(await store.get(key)).toBeNull();
    expect(await statusOf(kept.document.id)).toBe('clean');
    expect(await statusOf(forever.document.id)).toBe('clean');
    expect(errorOf(await get(`/documents/${due.document.id}/download-url`))).toEqual([
      409,
      'document_blocked',
    ]);
    // The row stays on the record.
    const listed = (await get(`/patients/${ids.a}/documents?limit=100`)).json<{
      items: { id: string; status: string }[];
    }>();
    expect(listed.items.find((item) => item.id === due.document.id)?.status).toBe('purged');
  });
});

describe('merging two records', () => {
  it('moves the documents, hides the source and records who did it', async () => {
    const source = await patient(hospital, 'DC-0000020');
    const target = await patient(hospital, 'DC-0000021');
    const doc = await uploaded(source);
    await queue.drain();

    const done = await merge(target, source);
    expect(done.statusCode).toBe(201);
    const result = done.json<{ id: string; moved: Record<string, number>; mergedBy: string }>();
    expect(result).toMatchObject({
      sourcePatientId: source,
      targetPatientId: target,
      moved: { documents: 1 },
      mergedBy: admin.id,
    });

    const mine = (await get(`/patients/${target}/documents`)).json<{
      items: { id: string; patientId: string }[];
    }>();
    expect(mine.items).toEqual([
      expect.objectContaining({ id: doc.document.id, patientId: target }),
    ]);
    expect(
      (await get(`/patients/${source}/documents`)).json<{ items: unknown[] }>().items,
    ).toHaveLength(0);
    const original = await pool.query<{ original_patient_id: string }>(
      'select original_patient_id from patient_documents where id = $1',
      [doc.document.id],
    );
    expect(original.rows[0]?.original_patient_id).toBe(source);

    // The source points at the survivor, cannot be changed, and no longer takes documents.
    const record = (await get(`/patients/${source}`)).json<{
      mergedInto: string;
      version: number;
    }>();
    expect(record.mergedInto).toBe(target);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/patients/${source}`,
      headers: headers(),
      payload: { expectedVersion: record.version, firstName: 'Changed' },
    });
    expect(errorOf(edit)).toEqual([409, 'patient_merged']);
    expect(errorOf(await ask(source))).toEqual([409, 'patient_merged']);
    const found = await app.inject({
      method: 'POST',
      url: '/patients/search',
      headers: headers(),
      payload: { q: 'DC-0000020' },
    });
    expect(found.json<{ items: unknown[] }>().items).toHaveLength(0);

    const history = (await get(`/patients/${target}/merges`)).json<{ items: { id: string }[] }>();
    expect(history.items.map((item) => item.id)).toEqual([result.id]);
    expect(await actions('patient_merge', result.id)).toEqual(['create', 'read']);
    expect(await actions('patient', source)).toContain('update');
    const events = await pool.query(
      "select 1 from outbox where tenant_id = $1 and event = 'patient.merged' and entity_id = $2",
      [hospital.id, target],
    );
    expect(events.rowCount).toBe(1);
  });

  it('does all of it or none: a module that fails undoes the whole merge', async () => {
    const source = await patient(hospital, 'DC-0000030');
    const target = await patient(hospital, 'DC-0000031');
    const doc = await uploaded(source);
    failMerge = true;
    try {
      expect((await merge(target, source)).statusCode).toBe(500);
    } finally {
      failMerge = false;
    }
    const row = await pool.query<{ merged_into_id: string | null }>(
      'select merged_into_id from patients where id = $1',
      [source],
    );
    expect(row.rows[0]?.merged_into_id).toBeNull();
    const document = await pool.query<{ patient_id: string }>(
      'select patient_id from patient_documents where id = $1',
      [doc.document.id],
    );
    expect(document.rows[0]?.patient_id).toBe(source);
    const merges = await pool.query('select 1 from patient_merges where source_patient_id = $1', [
      source,
    ]);
    expect(merges.rowCount).toBe(0);
    // And it can be done once the module is well again.
    expect((await merge(target, source)).statusCode).toBe(201);
  });

  it('refuses itself, a merged record, a stale version, another hospital and a role without the permission', async () => {
    const a = await patient(hospital, 'DC-0000040');
    const b = await patient(hospital, 'DC-0000041');
    const c = await patient(hospital, 'DC-0000042');
    expect(errorOf(await merge(a, a))).toEqual([422, 'same_patient']);
    expect(
      errorOf(
        await post(`/patients/${a}/merge`, {
          sourcePatientId: b,
          reason: 'Duplicate',
          expectedVersion: 99,
          expectedSourceVersion: await versionOf(b),
        }),
      ),
    ).toEqual([409, 'conflict']);
    expect(errorOf(await merge(a, b, { user: receptionist }))).toEqual([403, 'permission_denied']);
    expect(errorOf(await merge(a, ids.clinicPatient))).toEqual([404, 'not_found']);
    expect(errorOf(await merge(a, b, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'not_found',
    ]);

    expect((await merge(a, b)).statusCode).toBe(201);
    // b is gone into a: it can be neither a source nor a survivor again.
    expect(errorOf(await merge(c, b))).toEqual([409, 'patient_merged']);
    expect(errorOf(await merge(b, c))).toEqual([409, 'patient_merged']);
  });

  it('answers a repeated request with the same merge', async () => {
    const source = await patient(hospital, 'DC-0000050');
    const target = await patient(hospital, 'DC-0000051');
    const key = randomUUID();
    const body = {
      sourcePatientId: source,
      reason: 'Same person',
      expectedVersion: await versionOf(target),
      expectedSourceVersion: await versionOf(source),
    };
    const first = (await post(`/patients/${target}/merge`, body, {}, key)).json<{ id: string }>();
    const again = await post(`/patients/${target}/merge`, body, {}, key);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).toBe(first.id);
  });

  it('is guarded by the database: a document moves only with its merge', async () => {
    const upload = await uploaded(ids.a);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role mediflow_app');
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', hospital.id]);
      await expect(
        client.query('update patient_documents set patient_id = $2 where id = $1', [
          upload.document.id,
          ids.c,
        ]),
      ).rejects.toThrow(/moves only when/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
