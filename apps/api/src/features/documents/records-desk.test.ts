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

/** The medical records desk (#570): incomplete records, the coding queue, copy requests. */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let bare: TestTenant;
let admin: TestUser;
let doctorUser: TestUser;
let receptionist: TestUser;
let clinicAdmin: TestUser;
let bareAdmin: TestUser;
const ids = {
  patient: '',
  clinicPatient: '',
  barePatient: '',
  doctor: '',
  clinicDoctor: '',
  icd: '',
  icd2: '',
  procedureCode: '',
  noteOpen: '',
  complete: '',
  noConsent: '',
  inpatient: '',
  open: '',
  clinicEncounter: '',
  fever: '',
  cough: '',
};
const codeValues = [
  `ZQ${Math.floor(Math.random() * 90 + 10)}.1`,
  `ZQ${Math.floor(Math.random() * 90 + 10)}.2`,
];

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

interface Incomplete {
  encounterId: string;
  gaps: string[];
  assignedDoctorId?: string;
  doctorName: string;
}
interface Coding {
  diagnosisId: string;
  version: number;
  code?: { code: string };
}
interface Req {
  id: string;
  state: string;
  version: number;
  note?: string;
  dueOn?: string;
  requestedOn: string;
}

async function one(sql: string, params: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
}
const patient = (tenant: TestTenant, mrn: string) =>
  one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Desk', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, mrn],
  );
const encounter = (tenant: TestTenant, patientId: string, type: string, status = 'closed') =>
  one(
    `insert into encounters (tenant_id, patient_id, type, status, opened_by, ended_at, ended_by)
     values ($1, $2, $3, $4, $5, case when $4 = 'open' then null else now() end,
             case when $4 = 'open' then null else $5::uuid end) returning id`,
    [tenant.id, patientId, type, status, admin.id],
  );
const diagnosis = (encounterId: string, text: string) =>
  one(
    `insert into encounter_diagnoses (tenant_id, encounter_id, patient_id, text, kind, recorded_by)
     select tenant_id, id, patient_id, $2, 'final', $3 from encounters where id = $1 returning id`,
    [encounterId, text, doctorUser.id],
  );

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const on = { patients: true, documents: true, records: true };
  hospital = await createTenant(pool, 'Desk Hospital', { features: on });
  clinic = await createTenant(pool, 'Desk Clinic', { features: on });
  bare = await createTenant(pool, 'Desk Bare', { features: { patients: true, documents: true } });
  for (const tenant of [hospital, clinic, bare]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Desk Admin');
  doctorUser = await user('Desk Doctor');
  receptionist = await user('Desk Receptionist');
  clinicAdmin = await user('Desk Clinic Admin');
  bareAdmin = await user('Desk Bare Admin');
  const clinicDoctorUser = await user('Desk Clinic Doctor');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctorUser, hospital, 'doctor');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, bareAdmin, bare, 'admin');
  await addMembership(pool, clinicDoctorUser, clinic, 'doctor');
  const department = (tenant: TestTenant) =>
    one('insert into departments (tenant_id, name) values ($1, $2) returning id', [
      tenant.id,
      'Medicine',
    ]);
  const doctor = async (tenant: TestTenant, userId: string) =>
    one(
      `insert into doctors (tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, 'General', 15) returning id`,
      [tenant.id, userId, await department(tenant)],
    );
  ids.doctor = await doctor(hospital, doctorUser.id);
  ids.clinicDoctor = await doctor(clinic, clinicDoctorUser.id);
  ids.patient = await patient(hospital, 'DK-0000001');
  ids.clinicPatient = await patient(clinic, 'DK-0000001');
  ids.barePatient = await patient(bare, 'DK-0000001');
  ids.icd = await one(
    "insert into codes (system, code, title) values ('icd10', $1, 'Desk test fever') returning id",
    [codeValues[0]],
  );
  ids.icd2 = await one(
    "insert into codes (system, code, title) values ('icd10', $1, 'Desk test cough') returning id",
    [codeValues[1]],
  );
  ids.procedureCode = await one(
    "insert into codes (system, code, title) values ('procedure', $1, 'Desk test procedure') returning id",
    [`ZP${Math.floor(Math.random() * 90 + 10)}`],
  );

  // An OPD visit with a note left as a draft and no diagnosis.
  ids.noteOpen = await encounter(hospital, ids.patient, 'opd');
  await pool.query(
    `insert into clinical_notes (tenant_id, encounter_id, patient_id, body, author_id)
     values ($1, $2, $3, '{"type":"doc"}', $4)`,
    [hospital.id, ids.noteOpen, ids.patient, doctorUser.id],
  );
  // A complete one: a diagnosis recorded as text, nothing else wanted.
  ids.complete = await encounter(hospital, ids.patient, 'opd');
  ids.fever = await diagnosis(ids.complete, 'Fever with chills');
  // A procedure without a consent on file.
  ids.noConsent = await encounter(hospital, ids.patient, 'opd');
  ids.cough = await diagnosis(ids.noConsent, 'Dry cough');
  const service = await one(
    `insert into services (tenant_id, code, name, category, tax_class)
     values ($1, 'DESK-PROC', 'Desk procedure', 'procedure', 'exempt') returning id`,
    [hospital.id],
  );
  await pool.query(
    `insert into orders (tenant_id, encounter_id, patient_id, type, service_id, item_code, item_name,
       ordered_by)
     values ($1, $2, $3, 'procedure', $4, 'DESK-PROC', 'Desk procedure', $5)`,
    [hospital.id, ids.noConsent, ids.patient, service, doctorUser.id],
  );
  // An inpatient stay with a diagnosis and no signed discharge summary.
  ids.inpatient = await encounter(hospital, ids.patient, 'ipd');
  await diagnosis(ids.inpatient, 'Pneumonia');
  // Still open: not a record for the desk yet.
  ids.open = await encounter(hospital, ids.patient, 'opd', 'open');
  ids.clinicEncounter = await encounter(clinic, ids.clinicPatient, 'opd');
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const tenants = [hospital.id, clinic.id, bare.id];
    for (const table of [
      'consent_withdrawals',
      'patient_consents',
      'template_versions',
      'templates',
      'record_requests',
      'record_assignments',
      'diagnosis_codings',
      'patient_documents',
      'orders',
      'services',
      'clinical_notes',
      'encounter_diagnoses',
      'encounters',
      'doctors',
      'departments',
      'outbox',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants]);
    }
    await client.query('delete from codes where id = any($1)', [
      [ids.icd, ids.icd2, ids.procedureCode],
    ]);
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, doctorUser, receptionist, clinicAdmin, bareAdmin]);
  await deleteTenants(pool, [hospital, clinic, bare]);
  await app.close();
});

describe('incomplete records', () => {
  it('works out each gap from the encounter and leaves out complete and open ones', async () => {
    const reply = await get('/records/incomplete?limit=100');
    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ items: Incomplete[]; total: number }>();
    const gapsOf = (id: string) => body.items.find((item) => item.encounterId === id)?.gaps;
    expect(gapsOf(ids.noteOpen)).toEqual(['unsigned_note', 'no_diagnosis']);
    expect(gapsOf(ids.noConsent)).toEqual(['missing_consent']);
    expect(gapsOf(ids.inpatient)).toEqual(['no_discharge_summary']);
    expect(gapsOf(ids.complete)).toBeUndefined();
    expect(gapsOf(ids.open)).toBeUndefined();
    expect(gapsOf(ids.clinicEncounter)).toBeUndefined();
    expect(body.total).toBe(3);
    expect(body.items.find((item) => item.encounterId === ids.noteOpen)?.doctorName).toBe(
      'Desk Admin',
    );
  });

  it('narrows by gap and kind, and pages oldest first with the total on the first page only', async () => {
    const byGap = await get('/records/incomplete?gap=missing_consent');
    expect(byGap.json<{ items: Incomplete[] }>().items.map((item) => item.encounterId)).toEqual([
      ids.noConsent,
    ]);
    const byKind = await get('/records/incomplete?kind=ipd');
    expect(byKind.json<{ total: number }>().total).toBe(1);
    const first = await get('/records/incomplete?limit=2');
    const page = first.json<{ items: Incomplete[]; nextCursor: string; total: number }>();
    expect(page.items.map((item) => item.encounterId)).toEqual([ids.noteOpen, ids.noConsent]);
    expect(page.total).toBe(3);
    const second = await get(`/records/incomplete?limit=2&cursor=${page.nextCursor}`);
    const rest = second.json<{ items: Incomplete[]; nextCursor: string | null; total?: number }>();
    expect(rest.items.map((item) => item.encounterId)).toEqual([ids.inpatient]);
    expect(rest.nextCursor).toBeNull();
    expect(rest.total).toBeUndefined();
    expect((await get('/records/incomplete?cursor=nonsense')).statusCode).toBe(400);
  });

  it('is complete once the consent is on file', async () => {
    await pool.query(
      `insert into patient_documents (tenant_id, patient_id, encounter_id, category, title, file_name,
         content_type, size_bytes, status, created_by, uploaded_at)
       values ($1, $2, $3, 'consent', 'Consent', 'c.pdf', 'application/pdf', 10, 'clean', $4, now())`,
      [hospital.id, ids.patient, ids.noConsent, admin.id],
    );
    const items = (await get('/records/incomplete?limit=100')).json<{ items: Incomplete[] }>()
      .items;
    expect(items.some((item) => item.encounterId === ids.noConsent)).toBe(false);
  });

  it('reads a structured consent for the encounter, unless it was withdrawn', async () => {
    await pool.query('delete from patient_documents where encounter_id = $1', [ids.noConsent]);
    const gaps = async () =>
      (await get('/records/incomplete?limit=100'))
        .json<{ items: Incomplete[] }>()
        .items.find((item) => item.encounterId === ids.noConsent)?.gaps;
    expect(await gaps()).toEqual(['missing_consent']);
    const template = await one(
      "insert into templates (tenant_id, kind, name) values ($1, 'consent', 'Consent') returning id",
      [hospital.id],
    );
    await pool.query(
      `insert into template_versions (tenant_id, template_id, version, name, body, saved_by)
       values ($1, $2, 1, 'Consent', '{"type":"doc","content":[]}', $3)`,
      [hospital.id, template, admin.id],
    );
    const consent = await one(
      `insert into patient_consents (tenant_id, patient_id, encounter_id, procedure_name, template_id,
         template_version, body, signer_name, signer_role, signature_method, signed_by)
       values ($1, $2, $3, 'Procedure', $4, 1, '{"type":"doc"}', 'Asha', 'patient', 'typed', $5)
       returning id`,
      [hospital.id, ids.patient, ids.noConsent, template, admin.id],
    );
    expect(await gaps()).toBeUndefined();
    await pool.query(
      `insert into consent_withdrawals (tenant_id, consent_id, patient_id, reason, withdrawn_by)
       values ($1, $2, $3, 'Changed mind', $4)`,
      [hospital.id, consent, ids.patient, admin.id],
    );
    expect(await gaps()).toEqual(['missing_consent']);
  });

  it('assigns a record to a practising doctor, replaces and removes the assignment', async () => {
    const url = `/records/incomplete/${ids.noteOpen}/assign`;
    const assigned = await post(url, { doctorId: ids.doctor });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<Incomplete>().assignedDoctorId).toBe(ids.doctor);
    const listed = (await get('/records/incomplete?limit=100')).json<{ items: Incomplete[] }>();
    expect(listed.items.find((item) => item.encounterId === ids.noteOpen)?.assignedDoctorId).toBe(
      ids.doctor,
    );
    expect(errorOf(await post(url, { doctorId: ids.clinicDoctor }))).toEqual([
      422,
      'not_practising',
    ]);
    const removed = await post(url, { doctorId: null });
    expect(removed.json<Incomplete>().assignedDoctorId).toBeUndefined();
    expect(
      errorOf(await post(`/records/incomplete/${ids.complete}/assign`, { doctorId: null })),
    ).toEqual([404, 'not_found']);
    expect(
      (await post(`/records/incomplete/${ids.clinicEncounter}/assign`, { doctorId: null }))
        .statusCode,
    ).toBe(404);
    const audited = await pool.query(
      "select 1 from audit_log where entity = 'record_assignment' and entity_id = $1",
      [ids.noteOpen],
    );
    expect(audited.rowCount).toBeGreaterThanOrEqual(2);
  });
});

describe('the coding queue', () => {
  const codeUrl = (id: string) => `/records/coding-queue/${id}/code`;

  it('lists the text diagnoses of closed encounters that have no code', async () => {
    const reply = await get('/records/coding-queue');
    const body = reply.json<{ items: Coding[]; total: number }>();
    expect(reply.statusCode).toBe(200);
    const listed = body.items.map((item) => item.diagnosisId);
    expect(listed).toContain(ids.fever);
    expect(listed).toContain(ids.cough);
    expect(body.items.find((item) => item.diagnosisId === ids.fever)?.version).toBe(1);
    expect(body.total).toBe(3);
  });

  it('codes at the version, refuses a stale one, and coding again replaces the code', async () => {
    const first = await post(codeUrl(ids.fever), { codeId: ids.icd, version: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json<Coding>()).toMatchObject({ version: 2, code: { code: codeValues[0] } });
    expect(errorOf(await post(codeUrl(ids.fever), { codeId: ids.icd2, version: 1 }))).toEqual([
      409,
      'version_conflict',
    ]);
    const again = await post(codeUrl(ids.fever), { codeId: ids.icd2, version: 2 });
    expect(again.json<Coding>()).toMatchObject({ version: 3, code: { code: codeValues[1] } });
    const uncoded = (await get('/records/coding-queue')).json<{ items: Coding[] }>().items;
    expect(uncoded.some((item) => item.diagnosisId === ids.fever)).toBe(false);
    const coded = (await get('/records/coding-queue?state=coded')).json<{ items: Coding[] }>()
      .items;
    expect(coded.map((item) => item.diagnosisId)).toEqual([ids.fever]);
    const actions = await pool.query<{ action: string }>(
      "select action from audit_log where entity = 'diagnosis_coding' and entity_id = $1 order by at",
      [ids.fever],
    );
    expect(actions.rows.map((row) => row.action)).toEqual(['create', 'update']);
    // The diagnosis itself was never touched.
    const stored = await pool.query('select code_id from encounter_diagnoses where id = $1', [
      ids.fever,
    ]);
    expect(stored.rows[0].code_id).toBeNull();
  });

  it('takes ICD-10 codes only, and a diagnosis of this hospital only', async () => {
    expect(
      errorOf(await post(codeUrl(ids.cough), { codeId: ids.procedureCode, version: 1 })),
    ).toEqual([422, 'not_icd10']);
    expect(errorOf(await post(codeUrl(ids.cough), { codeId: randomUUID(), version: 1 }))).toEqual([
      422,
      'not_icd10',
    ]);
    const clinicDiagnosis = await diagnosis(ids.clinicEncounter, 'Clinic cold');
    expect((await post(codeUrl(clinicDiagnosis), { codeId: ids.icd, version: 1 })).statusCode).toBe(
      404,
    );
    expect(
      (
        await post(
          codeUrl(ids.cough),
          { codeId: ids.icd, version: 1 },
          { tenant: clinic, user: clinicAdmin },
        )
      ).statusCode,
    ).toBe(404);
    const clinicQueue = await get('/records/coding-queue', { tenant: clinic, user: clinicAdmin });
    expect(clinicQueue.json<{ items: Coding[] }>().items.map((item) => item.diagnosisId)).toEqual([
      clinicDiagnosis,
    ]);
  });
});

describe('requests for copies of a record', () => {
  const create = (body: object = {}, options: Options = {}) =>
    post(
      '/record-requests',
      {
        patientId: ids.patient,
        requesterKind: 'insurer',
        requesterName: 'Star Health claims',
        purpose: 'Claim settlement',
        ...body,
      },
      options,
    );

  it('logs a request dated today, soonest due first, and refuses a due day in the past', async () => {
    const later = await create({ dueOn: hospitalDay(10) });
    const sooner = await create({ dueOn: hospitalDay(2) });
    const undated = await create();
    expect(later.statusCode).toBe(201);
    expect(later.json<Req>()).toMatchObject({
      state: 'open',
      version: 1,
      requestedOn: hospitalDay(),
    });
    expect(errorOf(await create({ dueOn: hospitalDay(-1) }))).toEqual([422, 'due_in_past']);
    expect(errorOf(await create({ patientId: ids.clinicPatient }))).toEqual([404, 'not_found']);
    const list = (await get('/record-requests?limit=2')).json<{
      items: Req[];
      nextCursor: string;
      total: number;
    }>();
    expect(list.items.map((item) => item.id)).toEqual([
      sooner.json<Req>().id,
      later.json<Req>().id,
    ]);
    expect(list.total).toBe(3);
    const rest = (await get(`/record-requests?limit=2&cursor=${list.nextCursor}`)).json<{
      items: Req[];
      nextCursor: string | null;
    }>();
    expect(rest.items.map((item) => item.id)).toEqual([undated.json<Req>().id]);
    expect(rest.nextCursor).toBeNull();
  });

  it('filters and counts the open requests past their due day', async () => {
    const late = (await create({ dueOn: hospitalDay(3), purpose: 'Late one' })).json<Req>();
    const today = (await create({ dueOn: hospitalDay(), purpose: 'Due today' })).json<Req>();
    const closedLate = (
      await create({ dueOn: hospitalDay(3), purpose: 'Closed late' })
    ).json<Req>();
    await pool.query('update record_requests set due_on = $2 where id = any($1::uuid[])', [
      [late.id, closedLate.id],
      hospitalDay(-2),
    ]);
    await post(`/record-requests/${closedLate.id}/close`, {
      outcome: 'declined',
      note: 'No',
      version: 2,
    });
    const overdue = (await get('/record-requests?overdue=true&limit=1')).json<{
      items: Req[];
      total: number;
    }>();
    expect(overdue.total).toBe(1);
    expect(overdue.items.map((item) => item.id)).toEqual([late.id]);
    const all = (await get('/record-requests?overdue=true&limit=100')).json<{ items: Req[] }>();
    expect(all.items.some((item) => item.id === today.id)).toBe(false);
  });

  it('filters the requests of one patient', async () => {
    const mine = (await create({ purpose: 'For the first' })).json<Req>();
    const second = await patient(hospital, 'DK-0000002');
    const other = (await create({ patientId: second, purpose: 'For another' })).json<Req>();
    const only = (await get(`/record-requests?patientId=${ids.patient}&limit=100`)).json<{
      items: Req[];
      total: number;
    }>();
    expect(only.items.some((item) => item.id === mine.id)).toBe(true);
    expect(only.items.some((item) => item.id === other.id)).toBe(false);
    expect(only.total).toBe(only.items.length);
    const found = (await get(`/record-requests?patientId=${second}`)).json<{
      items: Req[];
    }>();
    expect(found.items.map((item) => item.id)).toEqual([other.id]);
    expect((await get('/record-requests?patientId=nope')).statusCode).toBe(400);
  });

  it('closes a request once, at the version read, and never changes it after', async () => {
    const made = (await create({ purpose: 'Second opinion' })).json<Req>();
    const url = `/record-requests/${made.id}/close`;
    expect(
      errorOf(await post(url, { outcome: 'declined', note: 'No consent', version: 7 })),
    ).toEqual([409, 'version_conflict']);
    const closed = await post(url, { outcome: 'fulfilled', note: 'Copy handed over', version: 1 });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<Req>()).toMatchObject({ state: 'fulfilled', note: 'Copy handed over' });
    expect(errorOf(await post(url, { outcome: 'declined', note: 'Again', version: 2 }))).toEqual([
      409,
      'already_closed',
    ]);
    const open = (await get('/record-requests?state=open&limit=100')).json<{ items: Req[] }>();
    expect(open.items.some((item) => item.id === made.id)).toBe(false);
    await expect(
      pool.query("update record_requests set state = 'open' where id = $1", [made.id]),
    ).rejects.toThrow();
  });

  it('is refused for another hospital, a role without the permission, and a hospital with the module off', async () => {
    const made = (await create({ purpose: 'Visible here only' })).json<Req>();
    const close = { outcome: 'declined', note: 'No', version: 1 };
    expect(
      (
        await post(`/record-requests/${made.id}/close`, close, {
          tenant: clinic,
          user: clinicAdmin,
        })
      ).statusCode,
    ).toBe(404);
    const clinicList = await get('/record-requests', { tenant: clinic, user: clinicAdmin });
    expect(clinicList.json<{ items: Req[] }>().items).toEqual([]);
    for (const reply of [
      await get('/records/incomplete', { user: receptionist }),
      await get('/records/coding-queue', { user: receptionist }),
      await get('/record-requests', { user: receptionist }),
      await create({}, { user: receptionist }),
      await post(
        `/records/incomplete/${ids.noteOpen}/assign`,
        { doctorId: null },
        { user: receptionist },
      ),
      await post(
        `/records/coding-queue/${ids.cough}/code`,
        { codeId: ids.icd, version: 1 },
        { user: receptionist },
      ),
    ]) {
      expect(reply.statusCode).toBe(403);
    }
    const off = { tenant: bare, user: bareAdmin };
    expect((await get('/records/incomplete', off)).statusCode).toBe(403);
    expect((await get('/record-requests', off)).statusCode).toBe(403);
    expect((await create({ patientId: ids.barePatient }, off)).statusCode).toBe(403);
  });

  it('needs an idempotency key and answers a repeat with the first result', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: '/record-requests',
      headers: headers(),
      payload: { patientId: ids.patient, requesterKind: 'court', requesterName: 'A', purpose: 'B' },
    });
    expect(reply.statusCode).toBe(400);
    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/record-requests',
        headers: { ...headers(), 'idempotency-key': key },
        payload: {
          patientId: ids.patient,
          requesterKind: 'court',
          requesterName: 'A',
          purpose: 'B',
        },
      });
    const first = await send();
    const repeat = await send();
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json<Req>().id).toBe(first.json<Req>().id);
  });
});
