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
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/**
 * The insurance API through the real app and database: payers, plans and rate agreements,
 * policies and pre-authorizations; the hospital boundary, permissions, audit and the database's
 * own refusals.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let receptionist: TestUser;
let nurse: TestUser;
let clinicAdmin: TestUser;
let patientId: string;
let clinicPatientId: string;
let encounterId: string;
let serviceA: string;
let serviceB: string;
let clinicService: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

const headers = ({ tenant = hospital, user = admin, key }: Options = {}) => ({
  ...as(tenant.id, user.id),
  ...(key ? { 'idempotency-key': key } : {}),
});
let keys = 0;
const fresh = () => `ins-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const send = (method: 'POST' | 'PATCH', url: string, body: object, options: Options = {}) =>
  app.inject({
    method,
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    payload: body,
  });
const post = (url: string, body: object, options: Options = {}) => send('POST', url, body, options);
const patch = (url: string, body: object, options: Options = {}) =>
  send('PATCH', url, body, options);
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

const audited = async (entity: string, entityId: string) =>
  (
    await pool.query<{ action: string }>(
      'select action from audit_log where tenant_id = $1 and entity = $2 and entity_id = $3 order by at',
      [hospital.id, entity, entityId],
    )
  ).rows.map((row) => row.action);

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'pre_auths',
  'patient_policies',
  'rate_agreement_rates',
  'rate_agreements',
  'payer_plan_services',
  'payer_plans',
  'payers',
];
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of TABLES) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [tenants()]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const allOn = { insurance: true, patients: true, billing: true };

interface Payer {
  id: string;
  code: string;
  planCount: number;
  version: number;
  archived: boolean;
}
interface Plan {
  id: string;
  version: number;
  services: { serviceId: string; serviceName: string; limitMinor?: number }[];
  sumInsuredMinor?: number;
}
interface Agreement {
  id: string;
  version: number;
  effectiveTo?: string;
  rates: { serviceName: string; rateMinor: number }[];
}
interface Policy {
  id: string;
  version: number;
  status: string;
  payerName: string;
  planName: string;
}
interface PreAuth {
  id: string;
  version: number;
  status: string;
  billedMinor: number;
  approvedMinor?: number;
  encounterId?: string;
}

let codes = 0;
const payer = async (more: object = {}, options: Options = {}) =>
  ok<Payer>(
    await post(
      '/payers',
      { kind: 'insurer', code: `P${++codes}`, name: `Payer ${codes}`, ...more },
      options,
    ),
    201,
  );
const planBody = (more: object = {}) => ({
  code: `PL${++codes}`,
  name: `Plan ${codes}`,
  coverageMode: 'all_except',
  copayPercent: 10,
  preAuthRequired: true,
  services: [],
  ...more,
});
const plan = async (payerId: string, more: object = {}, options: Options = {}) =>
  ok<Plan>(await post(`/payers/${payerId}/plans`, planBody(more), options), 201);

const dayFrom = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Insurance Hospital', { features: allOn });
  clinic = await createTenant(pool, 'Insurance Clinic', { features: allOn });
  closed = await createTenant(pool, 'Insurance Closed', { features: { insurance: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Insurance Admin', { withPassword: false });
  receptionist = await createUser(pool, 'Insurance Desk', { withPassword: false });
  nurse = await createUser(pool, 'Insurance Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Insurance Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');

  const one = async (sql: string, params: unknown[]) =>
    ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
  const patient = (tenant: TestTenant, mrn: string) =>
    one(
      `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
       values ($1, $2, 'Ins', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
      [tenant.id, mrn],
    );
  patientId = await patient(hospital, 'IN-0000001');
  clinicPatientId = await patient(clinic, 'IN-0000002');
  encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [hospital.id, patientId, admin.id],
  );
  const service = (tenant: TestTenant, code: string, name: string) =>
    one(
      `insert into services (tenant_id, code, name, category, tax_class) values ($1, $2, $3, 'procedure', 'exempt') returning id`,
      [tenant.id, code, name],
    );
  serviceA = await service(hospital, 'INS-A', 'Insurance Service A');
  serviceB = await service(hospital, 'INS-B', 'Insurance Service B');
  clinicService = await service(clinic, 'INS-C', 'Clinic Service');
  for (const [n, price] of [
    [1, 100_000],
    [2, 250_000],
  ] as const) {
    await pool.query(
      `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
         description, quantity, unit_price_minor)
       values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, $6)`,
      [hospital.id, encounterId, patientId, serviceA, `ins-test:${n}`, price],
    );
  }
  await pool.query(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor, status)
     values ($1, $2, $3, $4, 'manual', 'ins-test:void', 'Voided', 1, 999, 'void')`,
    [hospital.id, encounterId, patientId, serviceA],
  );
}, 60_000);

afterAll(async () => {
  try {
    await wipe();
    await pool.query('delete from charges where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from encounters where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from services where tenant_id = any($1)', [tenants()]);
    await pool.query('delete from patients where tenant_id = any($1)', [tenants()]);
    await deleteUsers(pool, [admin, receptionist, nurse, clinicAdmin].filter(Boolean));
    await deleteTenants(pool, [hospital, clinic, closed].filter(Boolean));
  } finally {
    await app.close();
  }
});

describe('payers', () => {
  it('adds, reads, lists and edits an organisation: audited, versioned', async () => {
    await wipe();
    const made = await payer({ kind: 'tpa', phone: '+91 80 1', contactName: 'Desk' });
    expect(made).toMatchObject({ planCount: 0, archived: false, version: 1 });
    expect(await audited('payer', made.id)).toEqual(['create']);

    const detail = await ok<{ payer: Payer; plans: Plan[]; agreements: Agreement[] }>(
      await get(`/payers/${made.id}`),
    );
    expect(detail.payer.id).toBe(made.id);
    expect(detail.plans).toEqual([]);

    const changed = await ok<Payer & { phone?: string; name: string }>(
      await patch(`/payers/${made.id}`, { version: 1, name: ' Renamed ', phone: null }),
    );
    expect(changed).toMatchObject({ name: 'Renamed', version: 2 });
    expect(changed.phone).toBeUndefined();
    expect(errorOf(await patch(`/payers/${made.id}`, { version: 1, name: 'Late' }))).toEqual([
      409,
      'version_conflict',
    ]);
  });

  it('keeps a code once, whatever its capitals; an idempotent create returns the first', async () => {
    await wipe();
    await payer({ code: 'Star' });
    expect(
      errorOf(await post('/payers', { kind: 'insurer', code: 'STAR', name: 'Other' })),
    ).toEqual([409, 'duplicate_code']);
    const key = fresh();
    const body = { kind: 'insurer', code: 'ONCE', name: 'Once' };
    const first = await post('/payers', body, { key });
    const again = await post('/payers', body, { key });
    expect(again.statusCode).toBe(201);
    expect(again.json<Payer>().id).toBe(first.json<Payer>().id);
    expect(
      errorOf(await post('/payers', { kind: 'insurer', code: 'bad code', name: 'X' })),
    ).toEqual([400, 'validation_failed']);
  });

  it('lists by name with a search, a kind, archived and a cursor', async () => {
    await wipe();
    for (const [code, name, kind] of [
      ['A', 'Alpha', 'insurer'],
      ['B', 'Bravo', 'tpa'],
      ['C', 'Charlie', 'corporate'],
    ]) {
      await payer({ code, name, kind });
    }
    const archived = await payer({ code: 'D', name: 'Delta' });
    await ok(await patch(`/payers/${archived.id}`, { version: 1, archived: true }));

    const first = await ok<{ items: Payer[]; nextCursor: string | null; total: number }>(
      await get('/payers?limit=2'),
    );
    expect(first.items.map((one) => one.code)).toEqual(['A', 'B']);
    expect(first.total).toBe(3);
    const second = await ok<{ items: Payer[]; nextCursor: string | null }>(
      await get(`/payers?limit=2&cursor=${first.nextCursor}`),
    );
    expect(second.items.map((one) => one.code)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();
    expect((await ok<{ items: Payer[] }>(await get('/payers?q=brav'))).items).toHaveLength(1);
    expect((await ok<{ items: Payer[] }>(await get('/payers?kind=corporate'))).items).toHaveLength(
      1,
    );
    expect((await ok<{ items: Payer[] }>(await get('/payers?archived=true'))).items).toHaveLength(
      1,
    );
    expect((await ok<{ items: Payer[] }>(await get('/payers?q=%25'))).items).toHaveLength(0);
    expect(errorOf(await get('/payers?cursor=nonsense'))).toEqual([400, 'invalid_cursor']);
  });

  it('refuses without the permission, with the switch off, and across hospitals', async () => {
    await wipe();
    const mine = await payer();
    expect(errorOf(await get('/payers', { user: nurse }))).toEqual([403, 'permission_denied']);
    expect((await get('/payers', { user: receptionist })).statusCode).toBe(200);
    expect(
      errorOf(
        await post('/payers', { kind: 'insurer', code: 'R', name: 'R' }, { user: receptionist }),
      ),
    ).toEqual([403, 'permission_denied']);
    expect(errorOf(await get('/payers', { tenant: closed }))[1]).toBe('feature_disabled');

    const clinicsPayer = await payer({ code: 'SAME' }, { tenant: clinic, user: clinicAdmin });
    // The same code in another hospital is fine; each sees only its own.
    await payer({ code: 'SAME' });
    expect(errorOf(await get(`/payers/${clinicsPayer.id}`))).toEqual([404, 'payer_not_found']);
    expect(
      errorOf(
        await patch(
          `/payers/${mine.id}`,
          { version: 1, name: 'X' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'payer_not_found']);
    const clinicList = await ok<{ items: Payer[] }>(
      await get('/payers', { tenant: clinic, user: clinicAdmin }),
    );
    expect(clinicList.items.map((one) => one.id)).toEqual([clinicsPayer.id]);
    expect(errorOf(await get('/payers/not-a-uuid'))).toEqual([404, 'payer_not_found']);
  });

  it('is isolated by row-level security on every table', async () => {
    await wipe();
    const mine = await payer();
    await plan(mine.id, { services: [{ serviceId: serviceA }] });
    await asTenantSql(pool, clinic.id, async (client) => {
      for (const table of TABLES) {
        const { rows } = await client.query(`select 1 from ${table}`);
        expect(rows, table).toHaveLength(0);
      }
    });
  });
});

describe('plans', () => {
  it('adds a plan with its terms and services, then replaces them', async () => {
    await wipe();
    const org = await payer();
    const made = await plan(org.id, {
      sumInsuredMinor: 5_000_000,
      roomRentLimitMinor: 400_000,
      minAge: 1,
      maxAge: 60,
      waitingPeriodDays: 30,
      services: [{ serviceId: serviceA, limitMinor: 10_000 }, { serviceId: serviceB }],
    });
    expect(made.services.map((one) => one.serviceName)).toEqual([
      'Insurance Service A',
      'Insurance Service B',
    ]);
    expect(made.services[0]?.limitMinor).toBe(10_000);
    expect(made.sumInsuredMinor).toBe(5_000_000);
    expect(await audited('payer_plan', made.id)).toEqual(['create']);

    // A term sent replaces the old ones: a limit left out is removed, the services are as listed.
    const edited = await ok<Plan>(
      await patch(`/payer-plans/${made.id}`, {
        version: 1,
        copayPercent: 20,
        services: [{ serviceId: serviceB }],
      }),
    );
    expect(edited).toMatchObject({ version: 2 });
    expect(edited.sumInsuredMinor).toBeUndefined();
    expect(edited.services.map((one) => one.serviceId)).toEqual([serviceB]);
    // Archived alone changes nothing else.
    const archived = await ok<Plan & { archived: boolean; copayPercent: number }>(
      await patch(`/payer-plans/${made.id}`, { version: 2, archived: true }),
    );
    expect(archived).toMatchObject({ archived: true, copayPercent: 20, version: 3 });
    expect(
      errorOf(await patch(`/payer-plans/${made.id}`, { version: 2, archived: false })),
    ).toEqual([409, 'version_conflict']);
  });

  it('counts only live plans, keeps codes once per organisation, refuses bad input', async () => {
    await wipe();
    const org = await payer();
    const other = await payer();
    const made = await plan(org.id, { code: 'GOLD' });
    await plan(other.id, { code: 'GOLD' });
    expect(errorOf(await post(`/payers/${org.id}/plans`, planBody({ code: 'gold' })))).toEqual([
      409,
      'duplicate_code',
    ]);
    const detail = await ok<{ payer: Payer }>(await get(`/payers/${org.id}`));
    expect(detail.payer.planCount).toBe(1);
    await ok(await patch(`/payer-plans/${made.id}`, { version: 1, archived: true }));
    expect((await ok<{ payer: Payer }>(await get(`/payers/${org.id}`))).payer.planCount).toBe(0);

    expect(
      errorOf(
        await post(
          `/payers/${org.id}/plans`,
          planBody({ services: [{ serviceId: clinicService }] }),
        ),
      ),
    ).toEqual([422, 'unknown_service']);
    expect(
      errorOf(
        await post(
          `/payers/${org.id}/plans`,
          planBody({ services: [{ serviceId: serviceA }, { serviceId: serviceA }] }),
        ),
      ),
    ).toEqual([422, 'duplicate_service']);
    expect(
      errorOf(await post(`/payers/${org.id}/plans`, planBody({ minAge: 70, maxAge: 10 }))),
    ).toEqual([422, 'invalid_ages']);
    expect(errorOf(await post(`/payers/${org.id}/plans`, planBody({ copayPercent: 101 })))).toEqual(
      [400, 'validation_failed'],
    );
    const archivedOrg = await payer();
    await ok(await patch(`/payers/${archivedOrg.id}`, { version: 1, archived: true }));
    expect(errorOf(await post(`/payers/${archivedOrg.id}/plans`, planBody()))).toEqual([
      409,
      'payer_archived',
    ]);
    expect(
      errorOf(
        await post(`/payers/${org.id}/plans`, planBody(), { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'payer_not_found']);
    expect(
      errorOf(
        await patch(
          `/payer-plans/${made.id}`,
          { version: 2, name: 'X' },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'plan_not_found']);
  });

  it('the database keeps a plan’s code and payer', async () => {
    await wipe();
    const org = await payer();
    const made = await plan(org.id);
    await expect(
      pool.query('update payer_plans set code = $2 where id = $1', [made.id, 'CHANGED']),
    ).rejects.toThrow(/do not change/);
  });
});

describe('rate agreements', () => {
  const agreement = (more: object = {}) => ({
    name: 'Network 2031',
    effectiveFrom: dayFrom(10),
    effectiveTo: dayFrom(40),
    discountBp: 1000,
    rates: [{ serviceId: serviceA, rateMinor: 90_000 }],
    ...more,
  });

  it('adds an agreement with its rates, never overlapping, and only ends it', async () => {
    await wipe();
    const org = await payer();
    const made = await ok<Agreement>(
      await post(`/payers/${org.id}/rate-agreements`, agreement()),
      201,
    );
    expect(made.rates).toEqual([
      { serviceId: serviceA, serviceName: 'Insurance Service A', rateMinor: 90_000 },
    ]);
    expect(await audited('rate_agreement', made.id)).toEqual(['create']);

    // Closed ranges: sharing the last day overlaps; the day after does not.
    expect(
      errorOf(
        await post(
          `/payers/${org.id}/rate-agreements`,
          agreement({ effectiveFrom: dayFrom(40), effectiveTo: dayFrom(50) }),
        ),
      ),
    ).toEqual([409, 'agreement_overlap']);
    const next = await ok<Agreement>(
      await post(
        `/payers/${org.id}/rate-agreements`,
        agreement({ name: 'Next', effectiveFrom: dayFrom(41), effectiveTo: undefined }),
      ),
      201,
    );
    // An open-ended agreement blocks everything after it.
    expect(
      errorOf(
        await post(
          `/payers/${org.id}/rate-agreements`,
          agreement({ effectiveFrom: dayFrom(100), effectiveTo: dayFrom(110) }),
        ),
      ),
    ).toEqual([409, 'agreement_overlap']);
    // Another organisation is free of it.
    const other = await payer();
    await ok(await post(`/payers/${other.id}/rate-agreements`, agreement()), 201);

    // Ending the first later than the next one starts runs into it.
    expect(
      errorOf(await patch(`/rate-agreements/${made.id}`, { version: 1, effectiveTo: dayFrom(60) })),
    ).toEqual([409, 'agreement_overlap']);
    const ended = await ok<Agreement>(
      await patch(`/rate-agreements/${made.id}`, { version: 1, effectiveTo: dayFrom(20) }),
    );
    expect(ended).toMatchObject({ effectiveTo: dayFrom(20), version: 2 });
    const reopened = await ok<Agreement>(
      await patch(`/rate-agreements/${next.id}`, { version: 1, effectiveTo: null }),
    );
    expect(reopened.effectiveTo).toBeUndefined();
    expect(
      errorOf(await patch(`/rate-agreements/${made.id}`, { version: 1, effectiveTo: dayFrom(21) })),
    ).toEqual([409, 'version_conflict']);
    expect(
      errorOf(await patch(`/rate-agreements/${made.id}`, { version: 2, effectiveTo: dayFrom(-5) })),
    ).toEqual([422, 'validation_failed']);

    const detail = await ok<{ agreements: Agreement[] }>(await get(`/payers/${org.id}`));
    expect(detail.agreements.map((one) => one.id)).toEqual([next.id, made.id]);
  });

  it('refuses a start in the past, a last day before the first, an unknown service', async () => {
    await wipe();
    const org = await payer();
    const url = `/payers/${org.id}/rate-agreements`;
    expect(errorOf(await post(url, agreement({ effectiveFrom: dayFrom(-3) })))).toEqual([
      422,
      'starts_in_past',
    ]);
    expect(
      errorOf(await post(url, agreement({ effectiveFrom: dayFrom(5), effectiveTo: dayFrom(2) }))),
    ).toEqual([400, 'validation_failed']);
    expect(
      errorOf(await post(url, agreement({ rates: [{ serviceId: clinicService, rateMinor: 1 }] }))),
    ).toEqual([422, 'unknown_service']);
    expect(errorOf(await post(url, agreement(), { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'payer_not_found',
    ]);
  });

  it('the database never lets an agreement be edited, only ended', async () => {
    await wipe();
    const org = await payer();
    const made = await ok<Agreement>(
      await post(`/payers/${org.id}/rate-agreements`, agreement()),
      201,
    );
    await expect(
      pool.query('update rate_agreements set discount_bp = 1 where id = $1', [made.id]),
    ).rejects.toThrow(/only ended/);
    // The application role may add rates but not change or remove them.
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('update rate_agreement_rates set rate_minor = 1 where agreement_id = $1', [
          made.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('policies', () => {
  const policy = (planId: string, more: object = {}) => ({
    planId,
    policyNumber: `POL-${++codes}`,
    holderName: 'Holder Name',
    relationship: 'self',
    validFrom: dayFrom(-30),
    ...more,
  });
  async function setup() {
    await wipe();
    const org = await payer({ name: 'Star Cover' });
    const made = await plan(org.id, { name: 'Gold' });
    return { org, made };
  }

  it('puts a policy on the record: status worked out, audited, read back', async () => {
    const { made } = await setup();
    const created = await ok<Policy>(
      await post(`/patients/${patientId}/policies`, policy(made.id, { memberId: 'M-1' })),
      201,
    );
    expect(created).toMatchObject({
      status: 'active',
      payerName: 'Star Cover',
      planName: 'Gold',
      preAuthRequired: true,
      version: 1,
    });
    expect(await audited('patient_policy', created.id)).toEqual(['create']);

    const expired = await ok<Policy>(
      await post(
        `/patients/${patientId}/policies`,
        policy(made.id, { validFrom: dayFrom(-60), validTo: dayFrom(-1) }),
      ),
      201,
    );
    expect(expired.status).toBe('expired');
    const list = await ok<Policy[]>(await get(`/patients/${patientId}/policies`));
    expect(list.map((one) => one.id)).toEqual([expired.id, created.id]);
    expect(await audited('patient_policy', created.id)).toEqual(['create', 'read']);
  });

  it('refuses a duplicate, an archived plan, a backward period, and an unknown plan', async () => {
    const { org, made } = await setup();
    const first = policy(made.id, { policyNumber: 'SAME-1' });
    const created = await ok<Policy>(await post(`/patients/${patientId}/policies`, first), 201);
    expect(errorOf(await post(`/patients/${patientId}/policies`, first))).toEqual([
      409,
      'duplicate_policy',
    ]);
    // Once ended the same card may be added again.
    await ok(await post(`/patient-policies/${created.id}/end`, { version: 1 }));
    await ok(await post(`/patients/${patientId}/policies`, first), 201);

    expect(
      errorOf(
        await post(
          `/patients/${patientId}/policies`,
          policy(made.id, { validFrom: dayFrom(5), validTo: dayFrom(1) }),
        ),
      ),
    ).toEqual([422, 'validation_failed']);
    expect(errorOf(await post(`/patients/${patientId}/policies`, policy(clinicService)))).toEqual([
      404,
      'plan_not_found',
    ]);
    await ok(await patch(`/payer-plans/${made.id}`, { version: 1, archived: true }));
    expect(errorOf(await post(`/patients/${patientId}/policies`, policy(made.id)))).toEqual([
      409,
      'plan_archived',
    ]);
    const livePlan = await plan(org.id);
    await ok(await patch(`/payers/${org.id}`, { version: 1, archived: true }));
    expect(errorOf(await post(`/patients/${patientId}/policies`, policy(livePlan.id)))).toEqual([
      409,
      'plan_archived',
    ]);
  });

  it('ends a policy once, and ended is the status', async () => {
    const { made } = await setup();
    const created = await ok<Policy>(
      await post(`/patients/${patientId}/policies`, policy(made.id)),
      201,
    );
    expect(errorOf(await post(`/patient-policies/${created.id}/end`, { version: 5 }))).toEqual([
      409,
      'version_conflict',
    ]);
    const ended = await ok<Policy>(
      await post(`/patient-policies/${created.id}/end`, { version: 1 }),
    );
    expect(ended).toMatchObject({ status: 'ended', version: 2 });
    expect(await audited('patient_policy', created.id)).toEqual(['create', 'update']);
    expect(errorOf(await post(`/patient-policies/${created.id}/end`, { version: 2 }))).toEqual([
      409,
      'already_ended',
    ]);
    await expect(
      pool.query("update patient_policies set holder_name = 'Other' where id = $1", [created.id]),
    ).rejects.toThrow(/only ended/);
  });

  it('keeps a patient’s policies inside the hospital and behind the permissions', async () => {
    const { made } = await setup();
    const created = await ok<Policy>(
      await post(`/patients/${patientId}/policies`, policy(made.id)),
      201,
    );
    expect(errorOf(await get(`/patients/${clinicPatientId}/policies`))).toEqual([
      404,
      'patient_not_found',
    ]);
    expect(
      errorOf(await get(`/patients/${patientId}/policies`, { tenant: clinic, user: clinicAdmin })),
    ).toEqual([404, 'patient_not_found']);
    expect(
      errorOf(
        await post(
          `/patient-policies/${created.id}/end`,
          { version: 1 },
          { tenant: clinic, user: clinicAdmin },
        ),
      ),
    ).toEqual([404, 'policy_not_found']);
    expect(errorOf(await get(`/patients/${patientId}/policies`, { user: nurse }))[0]).toBe(403);
    expect((await get(`/patients/${patientId}/policies`, { user: receptionist })).statusCode).toBe(
      200,
    );
    expect(errorOf(await get('/patients/not-a-uuid/policies'))).toEqual([404, 'patient_not_found']);
  });
});

describe('pre-authorizations', () => {
  async function setup() {
    await wipe();
    const org = await payer({ name: 'Star Cover' });
    const made = await plan(org.id, { name: 'Gold' });
    const held = await ok<Policy>(
      await post(`/patients/${patientId}/policies`, {
        planId: made.id,
        policyNumber: `PA-${++codes}`,
        holderName: 'Holder',
        relationship: 'self',
        validFrom: dayFrom(-10),
      }),
      201,
    );
    return held;
  }
  const request = (policyId: string, more: object = {}) => ({
    policyId,
    treatment: 'Knee replacement',
    requestedMinor: 5_000_000,
    documents: ['Admission note', 'MRI'],
    ...more,
  });

  it('asks, shows what the visit has been charged, and records the answer once', async () => {
    const held = await setup();
    const asked = await ok<PreAuth>(
      await post(`/patients/${patientId}/pre-auths`, request(held.id, { encounterId })),
      201,
    );
    // The voided charge is left out: 100000 + 250000.
    expect(asked).toMatchObject({
      status: 'submitted',
      billedMinor: 350_000,
      encounterId,
      payerName: 'Star Cover',
      planName: 'Gold',
      version: 1,
    });
    expect(await audited('pre_auth', asked.id)).toEqual(['create']);

    expect(
      errorOf(await post(`/pre-auths/${asked.id}/decision`, { version: 1, outcome: 'approved' })),
    ).toEqual([422, 'validation_failed']);
    expect(
      errorOf(await post(`/pre-auths/${asked.id}/decision`, { version: 9, outcome: 'rejected' })),
    ).toEqual([409, 'version_conflict']);
    const approved = await ok<PreAuth & { referenceNumber?: string; decidedAt?: string }>(
      await post(`/pre-auths/${asked.id}/decision`, {
        version: 1,
        outcome: 'approved',
        approvedMinor: 4_000_000,
        referenceNumber: 'PA-1',
        note: 'Room rent capped',
      }),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      approvedMinor: 4_000_000,
      referenceNumber: 'PA-1',
      version: 2,
    });
    expect(approved.decidedAt).toBeDefined();
    expect(
      errorOf(await post(`/pre-auths/${asked.id}/decision`, { version: 2, outcome: 'rejected' })),
    ).toEqual([409, 'not_submitted']);
    expect(errorOf(await post(`/pre-auths/${asked.id}/cancel`, { version: 2 }))).toEqual([
      409,
      'not_submitted',
    ]);
    expect(await audited('pre_auth', asked.id)).toEqual(['create', 'update']);
    await expect(
      pool.query('update pre_auths set requested_minor = 1 where id = $1', [asked.id]),
    ).rejects.toThrow(/answered or withdrawn once/);

    const forVisit = await ok<PreAuth[]>(await get(`/encounters/${encounterId}/pre-auths`));
    expect(forVisit.map((one) => one.id)).toEqual([asked.id]);
    expect(forVisit[0]?.billedMinor).toBe(350_000);
    const forPatient = await ok<PreAuth[]>(await get(`/patients/${patientId}/pre-auths`));
    expect(forPatient.map((one) => one.id)).toEqual([asked.id]);
  });

  it('rejects and withdraws; a request without a visit has nothing billed', async () => {
    const held = await setup();
    const one = await ok<PreAuth>(
      await post(`/patients/${patientId}/pre-auths`, request(held.id)),
      201,
    );
    expect(one.billedMinor).toBe(0);
    expect(one.encounterId).toBeUndefined();
    const rejected = await ok<PreAuth>(
      await post(`/pre-auths/${one.id}/decision`, {
        version: 1,
        outcome: 'rejected',
        approvedMinor: 5,
      }),
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.approvedMinor).toBeUndefined();

    const two = await ok<PreAuth>(
      await post(`/patients/${patientId}/pre-auths`, request(held.id)),
      201,
    );
    const withdrawn = await ok<PreAuth>(await post(`/pre-auths/${two.id}/cancel`, { version: 1 }));
    expect(withdrawn.status).toBe('cancelled');
    expect(
      errorOf(
        await post(`/pre-auths/${two.id}/decision`, {
          version: 2,
          outcome: 'approved',
          approvedMinor: 1,
        }),
      ),
    ).toEqual([409, 'not_submitted']);
  });

  it('needs an active policy of this patient and a visit of theirs', async () => {
    const held = await setup();
    const otherVisit = (
      await pool.query<{ id: string }>(
        `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'opd', $3) returning id`,
        [clinic.id, clinicPatientId, clinicAdmin.id],
      )
    ).rows[0]?.id as string;
    expect(
      errorOf(
        await post(
          `/patients/${patientId}/pre-auths`,
          request(held.id, { encounterId: otherVisit }),
        ),
      ),
    ).toEqual([404, 'encounter_not_found']);
    expect(errorOf(await post(`/patients/${patientId}/pre-auths`, request(clinicService)))).toEqual(
      [404, 'policy_not_found'],
    );
    await ok(await post(`/patient-policies/${held.id}/end`, { version: 1 }));
    expect(errorOf(await post(`/patients/${patientId}/pre-auths`, request(held.id)))).toEqual([
      409,
      'policy_not_active',
    ]);
    expect(errorOf(await post(`/patients/${clinicPatientId}/pre-auths`, request(held.id)))).toEqual(
      [404, 'patient_not_found'],
    );
    await pool.query('delete from encounters where id = $1', [otherVisit]);
  });

  it('is private to the hospital and to the permission', async () => {
    const held = await setup();
    const asked = await ok<PreAuth>(
      await post(`/patients/${patientId}/pre-auths`, request(held.id, { encounterId })),
      201,
    );
    const clinicSide = { tenant: clinic, user: clinicAdmin };
    expect(errorOf(await get(`/encounters/${encounterId}/pre-auths`, clinicSide))).toEqual([
      404,
      'encounter_not_found',
    ]);
    expect(errorOf(await get(`/patients/${patientId}/pre-auths`, clinicSide))).toEqual([
      404,
      'patient_not_found',
    ]);
    expect(
      errorOf(await post(`/pre-auths/${asked.id}/cancel`, { version: 1 }, clinicSide)),
    ).toEqual([404, 'pre_auth_not_found']);
    expect(errorOf(await get(`/patients/${patientId}/pre-auths`, { user: nurse }))[0]).toBe(403);
    expect(errorOf(await get(`/encounters/${encounterId}/pre-auths`, { tenant: closed }))[1]).toBe(
      'feature_disabled',
    );
    expect(
      errorOf(await post(`/pre-auths/${asked.id}/cancel`, { version: 1 }, { user: nurse }))[0],
    ).toBe(403);
    expect(errorOf(await get('/encounters/not-a-uuid/pre-auths'))).toEqual([
      404,
      'encounter_not_found',
    ]);
  });
});
