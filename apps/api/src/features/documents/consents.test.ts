import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  as,
  asTenantSql,
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

/** Signed consents and issued certificates (MR-02, #566). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let bare: TestTenant;
let admin: TestUser;
let doctor: TestUser;
let receptionist: TestUser;
let clinicAdmin: TestUser;
let bareAdmin: TestUser;
const ids = {
  patient: '',
  other: '',
  clinicPatient: '',
  barePatient: '',
  template: '',
  clinicTpl: '',
};

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
}
const headers = ({ tenant = hospital, user = admin }: Options = {}) => as(tenant.id, user.id);
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const send = (method: 'POST' | 'PUT', url: string, body: object, options: Options = {}) =>
  app.inject({
    method,
    url,
    headers: { ...headers(options), 'idempotency-key': randomUUID() },
    payload: body,
  });
const errorOf = (reply: { statusCode: number; json: () => { error: { code: string } } }) => [
  reply.statusCode,
  reply.json().error.code,
];

const text = (value: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});
const consent = (overrides: Record<string, unknown> = {}) => ({
  templateId: ids.template,
  templateVersion: 1,
  procedureName: 'Appendicectomy',
  body: text('I agree to the appendicectomy.'),
  signerName: 'Asha Rao',
  signerRole: 'patient',
  signatureMethod: 'drawn',
  signature: 'M 10 10 L 50 40 L 90 20',
  ...overrides,
});
const medical = (fields: Record<string, string> = {}) => ({
  kind: 'medical',
  issuedOn: hospitalDay(0),
  fields: {
    diagnosis: 'Viral fever',
    restFrom: hospitalDay(0),
    restTo: hospitalDay(2),
    ...fields,
  },
});

async function one(sql: string, params: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
}
const patient = (tenant: TestTenant, mrn: string) =>
  one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Consent', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, mrn],
  );
const template = async (tenant: TestTenant, user: TestUser, kind = 'consent') => {
  const id = await one(
    `insert into templates (tenant_id, kind, name) values ($1, $2, 'Surgery consent') returning id`,
    [tenant.id, kind],
  );
  await pool.query(
    `insert into template_versions (tenant_id, template_id, version, name, body, saved_by)
     values ($1, $2, 1, 'Surgery consent', '{"type":"doc","content":[]}', $3)`,
    [tenant.id, id, user.id],
  );
  return id;
};

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const on = { patients: true, consents: true, templates: true };
  hospital = await createTenant(pool, 'Consent Hospital', { features: on });
  clinic = await createTenant(pool, 'Consent Clinic', { features: on });
  bare = await createTenant(pool, 'Consent Bare', { features: { patients: true } });
  for (const tenant of [hospital, clinic, bare]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Consent Admin');
  doctor = await user('Consent Doctor');
  receptionist = await user('Consent Receptionist');
  clinicAdmin = await user('Consent Clinic Admin');
  bareAdmin = await user('Consent Bare Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await addMembership(pool, bareAdmin, bare, 'admin');
  ids.patient = await patient(hospital, 'CN-0000001');
  ids.other = await patient(hospital, 'CN-0000002');
  ids.clinicPatient = await patient(clinic, 'CN-0000001');
  ids.barePatient = await patient(bare, 'CN-0000001');
  ids.template = await template(hospital, admin);
  ids.clinicTpl = await template(clinic, clinicAdmin);
}, 60_000);

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const tenants = [hospital.id, clinic.id, bare.id];
    for (const table of [
      'consent_witnesses',
      'consent_withdrawals',
      'patient_consents',
      'encounters',
      'patient_certificates',
      'certificate_counters',
      'certificate_formats',
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
  await deleteUsers(pool, [admin, doctor, receptionist, clinicAdmin, bareAdmin]);
  await deleteTenants(pool, [hospital, clinic, bare]);
  await app.close();
});

interface Detail {
  consent: { id: string; patientId: string; signedByName: string; templateVersion: number };
  body: unknown;
  signature?: string;
}

describe('consents', () => {
  it('keeps the encounter it was signed for, and refuses one of another patient', async () => {
    const encounterId = await one(
      `insert into encounters (tenant_id, patient_id, type, status, opened_by)
       values ($1, $2, 'opd', 'open', $3) returning id`,
      [hospital.id, ids.patient, admin.id],
    );
    const signed = await send(
      'POST',
      `/patients/${ids.patient}/consents`,
      consent({ encounterId }),
    );
    expect(signed.statusCode).toBe(201);
    expect(signed.json<{ consent: { encounterId?: string } }>().consent.encounterId).toBe(
      encounterId,
    );
    const other = await send('POST', `/patients/${ids.other}/consents`, consent({ encounterId }));
    expect([other.statusCode, other.json<{ error: { code: string } }>().error.code]).toEqual([
      422,
      'encounter_mismatch',
    ]);
  });

  it('signs, lists and reads one, keeping the text and signature as sent', async () => {
    const signed = await send('POST', `/patients/${ids.patient}/consents`, consent());
    expect(signed.statusCode).toBe(201);
    const detail = signed.json<Detail>();
    expect(detail.consent).toMatchObject({
      patientId: ids.patient,
      signedByName: 'Consent Admin',
      templateVersion: 1,
    });
    expect(detail.signature).toBe('M 10 10 L 50 40 L 90 20');
    expect(detail.body).toEqual(text('I agree to the appendicectomy.'));

    const list = await get(`/patients/${ids.patient}/consents`);
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(items.items.map((item) => item.id)).toContain(detail.consent.id);
    expect(items.nextCursor).toBeNull();

    const read = await get(`/consents/${detail.consent.id}`);
    expect(read.json<Detail>().signature).toBe(detail.signature);
    const { rows } = await pool.query(
      "select 1 from audit_log where entity = 'patient_consent' and entity_id = $1 and action = 'read'",
      [detail.consent.id],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('answers a repeated request with the first consent and keeps one row', async () => {
    const key = randomUUID();
    const send1 = () =>
      app.inject({
        method: 'POST',
        url: `/patients/${ids.other}/consents`,
        headers: { ...headers(), 'idempotency-key': key },
        payload: consent({ signatureMethod: 'typed', signature: undefined }),
      });
    const first = await send1();
    const second = await send1();
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json<Detail>().consent.id).toBe(first.json<Detail>().consent.id);
    expect(first.json<Detail>().signature).toBeUndefined();
    const { rows } = await pool.query('select 1 from patient_consents where patient_id = $1', [
      ids.other,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a signature that does not fit its method, an unfilled text and an unknown template', async () => {
    const url = `/patients/${ids.patient}/consents`;
    expect(errorOf(await send('POST', url, consent({ signatureMethod: 'typed' })))).toEqual([
      422,
      'signature_invalid',
    ]);
    expect(errorOf(await send('POST', url, consent({ signature: undefined })))).toEqual([
      422,
      'signature_invalid',
    ]);
    expect(
      errorOf(await send('POST', url, consent({ body: text('Hello {{patient.name}}') }))),
    ).toEqual([422, 'placeholders_unfilled']);
    expect(errorOf(await send('POST', url, consent({ templateVersion: 7 })))).toEqual([
      422,
      'template_not_found',
    ]);
    // Another hospital's template, and a template of another kind, are not consent templates here.
    expect(errorOf(await send('POST', url, consent({ templateId: ids.clinicTpl })))).toEqual([
      422,
      'template_not_found',
    ]);
    const note = await template(hospital, admin, 'clinical_note');
    expect(errorOf(await send('POST', url, consent({ templateId: note })))).toEqual([
      422,
      'template_not_found',
    ]);
    expect(
      (await send('POST', url, consent({ body: { type: 'doc', content: [] } }))).statusCode,
    ).toBe(400);
    expect((await send('POST', url, consent({ signature: '<svg onload=x>' }))).statusCode).toBe(
      400,
    );
  });

  it('cannot be changed or removed, even by the application role', async () => {
    const id = await one('select id from patient_consents where patient_id = $1 limit 1', [
      ids.patient,
    ]);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update patient_consents set procedure_name = 'x' where id = $1", [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from patient_consents where id = $1', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const reply = await app.inject({
        method,
        url: `/consents/${id}`,
        headers: headers(),
        payload: method === 'DELETE' ? undefined : {},
      });
      expect(reply.statusCode).toBe(404);
    }
  });

  it('is off while the hospital’s consents switch is off', async () => {
    const off = await get(`/patients/${ids.barePatient}/consents`, {
      tenant: bare,
      user: bareAdmin,
    });
    expect(errorOf(off)).toEqual([403, 'feature_disabled']);
    expect(
      errorOf(
        await send('POST', `/patients/${ids.barePatient}/certificates`, medical(), {
          tenant: bare,
          user: bareAdmin,
        }),
      ),
    ).toEqual([403, 'feature_disabled']);
    expect((await get('/certificate-formats', { tenant: bare, user: bareAdmin })).statusCode).toBe(
      403,
    );
  });

  it('keeps one hospital out of the other', async () => {
    const own = await send('POST', `/patients/${ids.patient}/consents`, consent());
    const id = own.json<Detail>().consent.id;
    const asClinic = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(`/consents/${id}`, asClinic))).toEqual([404, 'not_found']);
    expect(errorOf(await get(`/patients/${ids.patient}/consents`, asClinic))).toEqual([
      404,
      'not_found',
    ]);
    expect(
      (await send('POST', `/patients/${ids.patient}/consents`, consent(), asClinic)).statusCode,
    ).toBe(404);
    // The clinic's own patient cannot use the hospital's template either.
    expect(
      (await send('POST', `/patients/${ids.clinicPatient}/consents`, consent(), asClinic))
        .statusCode,
    ).toBe(422);
    const clinicList = await get(`/patients/${ids.clinicPatient}/consents`, asClinic);
    expect(clinicList.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe('witnesses and withdrawal (#989)', () => {
  const witness = (overrides: Record<string, unknown> = {}) => ({
    witnessName: 'Ravi Menon',
    relation: 'Nurse',
    signatureMethod: 'typed',
    ...overrides,
  });
  const newConsent = async (patientId = ids.patient) =>
    (await send('POST', `/patients/${patientId}/consents`, consent())).json<Detail>().consent.id;

  it('adds witnesses as new entries and leaves the signed consent as it was', async () => {
    const id = await newConsent();
    const first = await send('POST', `/consents/${id}/witnesses`, witness());
    expect(first.statusCode).toBe(201);
    await send(
      'POST',
      `/consents/${id}/witnesses`,
      witness({ witnessName: 'Lata Iyer', signatureMethod: 'drawn', signature: 'M 1 1 L 5 5' }),
    );
    const read = (await get(`/consents/${id}`)).json<
      Detail & { witnesses: { witnessName: string; recordedByName: string; signature?: string }[] }
    >();
    expect(read.witnesses.map((w) => w.witnessName)).toEqual(['Ravi Menon', 'Lata Iyer']);
    expect(read.witnesses[0]!.recordedByName).toBe('Consent Admin');
    expect(read.witnesses[1]!.signature).toBe('M 1 1 L 5 5');
    expect(read.signature).toBe('M 10 10 L 50 40 L 90 20');
    const list = await get(`/patients/${ids.patient}/consents?limit=100`);
    const row = list
      .json<{ items: { id: string; witnessCount: number }[] }>()
      .items.find((item) => item.id === id);
    expect(row?.witnessCount).toBe(2);
    const bad = await send('POST', `/consents/${id}/witnesses`, witness({ signature: 'M 1 1' }));
    expect(errorOf(bad)).toEqual([422, 'signature_invalid']);
  });

  it('withdraws once with a reason, and takes no witness afterwards', async () => {
    const id = await newConsent();
    const done = await send('POST', `/consents/${id}/withdraw`, { reason: 'Changed my mind' });
    expect(done.statusCode).toBe(200);
    const detail = done.json<
      Detail & {
        consent: { withdrawnAt?: string };
        withdrawal: { reason: string; withdrawnByName: string };
      }
    >();
    expect(detail.consent.withdrawnAt).toBeTruthy();
    expect(detail.withdrawal).toMatchObject({
      reason: 'Changed my mind',
      withdrawnByName: 'Consent Admin',
    });
    expect(errorOf(await send('POST', `/consents/${id}/withdraw`, { reason: 'Again' }))).toEqual([
      409,
      'already_withdrawn',
    ]);
    expect(errorOf(await send('POST', `/consents/${id}/witnesses`, witness()))).toEqual([
      409,
      'consent_withdrawn',
    ]);
    // The signed text is untouched.
    expect((await get(`/consents/${id}`)).json<Detail>().body).toEqual(
      text('I agree to the appendicectomy.'),
    );
    const { rows } = await pool.query(
      "select 1 from outbox where tenant_id = $1 and event = 'consent.withdrawn'",
      [hospital.id],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('cannot be changed or removed, and stays inside the hospital', async () => {
    const id = await newConsent();
    await send('POST', `/consents/${id}/witnesses`, witness());
    await send('POST', `/consents/${id}/withdraw`, { reason: 'No' });
    for (const table of ['consent_witnesses', 'consent_withdrawals']) {
      await expect(
        asTenantSql(pool, hospital.id, (client) => client.query(`delete from ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asTenantSql(pool, hospital.id, (client) =>
          client.query(`update ${table} set tenant_id = tenant_id`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const asClinic = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await send('POST', `/consents/${id}/witnesses`, witness(), asClinic))).toEqual([
      404,
      'not_found',
    ]);
    expect(
      errorOf(await send('POST', `/consents/${id}/withdraw`, { reason: 'x' }, asClinic)),
    ).toEqual([404, 'not_found']);
  });
});

describe('withdrawing needs its own permission (#1035)', () => {
  const grant = (sql: string) => pool.query(sql, [hospital.id]);

  it('refuses a caller who can sign but was not granted consent:withdraw', async () => {
    const created = await send('POST', `/patients/${ids.patient}/consents`, consent());
    const id = created.json<Detail>().consent.id;
    const asReceptionist = { user: receptionist };
    const withdraw = (options: Options) =>
      send('POST', `/consents/${id}/withdraw`, { reason: 'Changed my mind' }, options);
    // The built-in role holds both by default.
    await grant(
      "delete from role_permissions where tenant_id = $1 and role_id = 'receptionist' and permission = 'consent:withdraw'",
    );
    try {
      const witnessed = await send(
        'POST',
        `/consents/${id}/witnesses`,
        { witnessName: 'Ravi Menon', relation: 'Nurse', signatureMethod: 'typed' },
        asReceptionist,
      );
      expect(witnessed.statusCode).toBe(201);
      expect(errorOf(await withdraw(asReceptionist))).toEqual([403, 'permission_denied']);
    } finally {
      await grant(
        "insert into role_permissions (tenant_id, role_id, permission) values ($1, 'receptionist', 'consent:withdraw') on conflict do nothing",
      );
    }
    expect((await withdraw(asReceptionist)).statusCode).toBe(200);
  });

  it('is off while the hospital’s consents switch is off', async () => {
    const reply = await send(
      'POST',
      `/consents/${randomUUID()}/withdraw`,
      { reason: 'x' },
      { tenant: bare, user: bareAdmin },
    );
    expect(errorOf(reply)).toEqual([403, 'feature_disabled']);
  });
});

describe('certificates', () => {
  it('numbers them in order for each kind and year and keeps what was entered', async () => {
    const url = `/patients/${ids.patient}/certificates`;
    const first = await send('POST', url, medical());
    const second = await send('POST', url, medical());
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const year = hospitalDay(0).slice(0, 4);
    const a = first.json<{ number: string; fields: Record<string, string>; layout: unknown[] }>();
    const b = second.json<{ number: string }>();
    expect(a.number).toBe(`MED-${year}-0001`);
    expect(b.number).toBe(`MED-${year}-0002`);
    expect(a.fields.diagnosis).toBe('Viral fever');
    expect(a.layout).toHaveLength(4);
    const fitness = await send('POST', url, {
      kind: 'fitness',
      issuedOn: hospitalDay(0),
      fields: { purpose: 'Sports', outcome: 'fit' },
    });
    expect(fitness.json<{ number: string }>().number).toBe(`FIT-${year}-0001`);
    // The counter of another hospital is its own.
    const other = await send('POST', `/patients/${ids.clinicPatient}/certificates`, medical(), {
      tenant: clinic,
      user: clinicAdmin,
    });
    expect(other.json<{ number: string }>().number).toBe(`MED-${year}-0001`);

    const list = await get(url);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(3);
    const page = await get(`${url}?limit=2`);
    const first2 = page.json<{ items: unknown[]; nextCursor: string }>();
    expect(first2.items).toHaveLength(2);
    const rest = await get(`${url}?limit=2&cursor=${first2.nextCursor}`);
    expect(rest.json<{ items: unknown[]; nextCursor: string | null }>()).toMatchObject({
      items: [expect.anything()],
      nextCursor: null,
    });
  });

  it('answers a repeated request with the first certificate', async () => {
    const key = randomUUID();
    const again = () =>
      app.inject({
        method: 'POST',
        url: `/patients/${ids.other}/certificates`,
        headers: { ...headers(), 'idempotency-key': key },
        payload: medical(),
      });
    const first = await again();
    const second = await again();
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const { rows } = await pool.query('select 1 from patient_certificates where patient_id = $1', [
      ids.other,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('refuses fields that do not fit the format', async () => {
    const url = `/patients/${ids.patient}/certificates`;
    const code = 'certificate_fields_invalid';
    expect(errorOf(await send('POST', url, medical({ diagnosis: '' })))).toEqual([422, code]);
    expect(errorOf(await send('POST', url, medical({ unknown: 'x' })))).toEqual([422, code]);
    expect(errorOf(await send('POST', url, medical({ restTo: 'tomorrow' })))).toEqual([422, code]);
    expect(
      errorOf(
        await send('POST', url, medical({ restFrom: hospitalDay(3), restTo: hospitalDay(1) })),
      ),
    ).toEqual([422, code]);
    expect(
      errorOf(
        await send('POST', url, {
          kind: 'fitness',
          issuedOn: hospitalDay(0),
          fields: { purpose: 'Sports', outcome: 'maybe' },
        }),
      ),
    ).toEqual([422, code]);
    expect(
      errorOf(
        await send('POST', url, {
          ...medical(),
          fields: {
            diagnosis: 7 as unknown as string,
            restFrom: hospitalDay(0),
            restTo: hospitalDay(1),
          },
        }),
      ),
    ).toEqual([422, code]);
    expect((await send('POST', url, { ...medical(), kind: 'passport' })).statusCode).toBe(400);
  });

  it('is issued only with certificate:issue, and read with certificate:read', async () => {
    const asReceptionist = { user: receptionist };
    expect(
      errorOf(
        await send('POST', `/patients/${ids.patient}/certificates`, medical(), asReceptionist),
      ),
    ).toEqual([403, 'permission_denied']);
    expect((await get(`/patients/${ids.patient}/certificates`, asReceptionist)).statusCode).toBe(
      200,
    );
    const asDoctor = { user: doctor };
    expect(
      (await send('POST', `/patients/${ids.patient}/certificates`, medical(), asDoctor)).statusCode,
    ).toBe(201);
  });

  it('cannot be changed or removed, even by the application role', async () => {
    const id = await one('select id from patient_certificates where patient_id = $1 limit 1', [
      ids.patient,
    ]);
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query("update patient_certificates set number = 'X' where id = $1", [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('delete from patient_certificates where id = $1', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps its layout when the hospital changes the format, and goes back on reset', async () => {
    const formats = await get('/certificate-formats');
    const list = formats.json<{ items: { kind: string; custom: boolean }[] }>().items;
    expect(list.map((item) => item.kind)).toEqual(['medical', 'fitness', 'birth', 'death']);
    expect(list.every((item) => !item.custom)).toBe(true);

    const fields = [
      { name: 'diagnosis', type: 'lines', required: true },
      { name: 'ward', label: 'Ward', type: 'select', required: true, options: ['A', 'B'] },
    ];
    const set = await app.inject({
      method: 'PUT',
      url: '/certificate-formats/medical',
      headers: headers(),
      payload: { fields },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ kind: 'medical', custom: true });

    const url = `/patients/${ids.patient}/certificates`;
    const code = 'certificate_fields_invalid';
    // The old standard field is gone, and the new one is needed.
    expect(errorOf(await send('POST', url, medical()))).toEqual([422, code]);
    const issued = await send('POST', url, {
      kind: 'medical',
      issuedOn: hospitalDay(0),
      fields: { diagnosis: 'Cough', ward: 'B' },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json<{ layout: unknown[] }>().layout).toEqual(fields);

    // Another hospital is not changed.
    const clinicFormats = await get('/certificate-formats', { tenant: clinic, user: clinicAdmin });
    expect(clinicFormats.json<{ items: { custom: boolean }[] }>().items[0]!.custom).toBe(false);

    const reset = await app.inject({
      method: 'DELETE',
      url: '/certificate-formats/medical',
      headers: headers(),
    });
    expect(reset.json()).toMatchObject({ kind: 'medical', custom: false });
    const old = await get(url);
    const kept = old
      .json<{ items: { fields: Record<string, string>; layout: unknown[] }[] }>()
      .items.find((item) => item.fields.ward === 'B');
    expect(kept?.layout).toEqual(fields);
  });

  it('refuses a format that cannot be used, and a change by someone who may not', async () => {
    const put = (fields: unknown[], user = admin) =>
      app.inject({
        method: 'PUT',
        url: '/certificate-formats/birth',
        headers: headers({ user }),
        payload: { fields },
      });
    const code = 'certificate_format_invalid';
    const field = { name: 'a', type: 'text', required: false };
    expect(errorOf(await put([field, field]))).toEqual([422, code]);
    expect(errorOf(await put([{ name: 'a', type: 'select', required: false }]))).toEqual([
      422,
      code,
    ]);
    expect(errorOf(await put([{ ...field, options: ['x'] }]))).toEqual([422, code]);
    expect((await put([])).statusCode).toBe(400);
    expect((await put([{ ...field, name: 'Bad name' }])).statusCode).toBe(400);
    expect(errorOf(await put([field], doctor))).toEqual([403, 'permission_denied']);
    const reset = await app.inject({
      method: 'DELETE',
      url: '/certificate-formats/birth',
      headers: headers({ user: doctor }),
    });
    expect(reset.statusCode).toBe(403);
  });
});

describe('a merged patient record', () => {
  it('shows the source record’s consents and certificates on the survivor', async () => {
    const survivor = await patient(hospital, 'CN-0000009');
    const source = await patient(hospital, 'CN-0000010');
    expect((await send('POST', `/patients/${source}/consents`, consent())).statusCode).toBe(201);
    expect(
      (await send('POST', `/patients/${source}/certificates`, medical({ diagnosis: 'Old' })))
        .statusCode,
    ).toBe(201);
    const version = async (id: string) =>
      (await pool.query<{ version: number }>('select version from patients where id = $1', [id]))
        .rows[0]!.version;
    const merged = await send('POST', `/patients/${survivor}/merge`, {
      sourcePatientId: source,
      reason: 'Duplicate registration',
      expectedVersion: await version(survivor),
      expectedSourceVersion: await version(source),
    });
    expect(merged.statusCode).toBe(201);
    const consents = await get(`/patients/${survivor}/consents`);
    expect(consents.json<{ items: unknown[] }>().items).toHaveLength(1);
    const certificates = await get(`/patients/${survivor}/certificates`);
    expect(certificates.json<{ items: unknown[] }>().items).toHaveLength(1);
    // Nothing new is written for the record merged away.
    expect(errorOf(await send('POST', `/patients/${source}/certificates`, medical()))).toEqual([
      409,
      'patient_merged',
    ]);
  });
});
