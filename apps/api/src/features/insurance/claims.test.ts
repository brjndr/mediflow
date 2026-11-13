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
  hospitalDay,
  grantRoleDefaults,
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';

/**
 * The coverage split and claims through the real app and database: the order of the split's
 * rules, the claim state machine, aging, events, the hospital boundary, permissions, audit and the
 * database's own refusals.
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
let serviceA: string;
let serviceB: string;
let serviceC: string;

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
const fresh = () => `clm-key-${String(++keys).padStart(6, '0')}`;
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, body: object | undefined, options: Options = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: headers({ ...options, key: options.key ?? fresh() }),
    ...(body ? { payload: body } : {}),
  });
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
const emitted = async (event: string, entityId: string) =>
  (
    await pool.query(
      'select 1 from outbox where tenant_id = $1 and event = $2 and entity_id = $3',
      [hospital.id, event, entityId],
    )
  ).rowCount;

const tenants = () => [hospital, clinic, closed].map((tenant) => tenant.id);
const TABLES = [
  'claim_events',
  'claims',
  'claim_counters',
  'coverage_splits',
  'pre_auths',
  'patient_policies',
  'rate_agreement_rates',
  'rate_agreements',
  'payer_plan_services',
  'payer_plans',
  'payers',
];
async function wipeAll(extra: string[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [...TABLES, ...extra]) {
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

interface Split {
  policyId: string;
  agreementName?: string;
  lines: {
    description: string;
    ledgerMinor: number;
    ratedMinor: number;
    payerMinor: number;
    patientMinor: number;
    reason: string;
  }[];
  ledgerMinor: number;
  rateAdjustmentMinor: number;
  payerMinor: number;
  patientMinor: number;
  saved?: { ledgerMinor: number; payerMinor: number };
  stale: boolean;
}
interface ClaimBody {
  id: string;
  number: string;
  status: string;
  version: number;
  claimedMinor: number;
  approvedMinor?: number;
  receivedMinor: number;
  writtenOffMinor: number;
  outstandingMinor: number;
  openQuery?: string;
  documents: string[];
  submittedAt?: string;
  payerId: string;
  events: { action: string; toStatus: string; amountMinor?: number; note?: string }[];
  allowedActions: string[];
}

const one = async (sql: string, params: unknown[]) =>
  ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

let mrn = 0;
/** A new patient with a visit and charges `[service, price]`. */
async function visit(charges: [string, number][], tenant: TestTenant = hospital) {
  const patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Clm', 'Patient', '1980-05-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CL-${String(++mrn).padStart(7, '0')}`],
  );
  const encounterId = await one(
    `insert into encounters (tenant_id, patient_id, type, opened_by) values ($1, $2, 'ipd', $3) returning id`,
    [tenant.id, patientId, admin.id],
  );
  for (const [service, price] of charges) await charge(encounterId, patientId, service, price);
  return { patientId, encounterId };
}
async function charge(encounterId: string, patientId: string, service: string, price: number) {
  await pool.query(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor)
     values ($1, $2, $3, $4, 'manual', $5, 'Charge', 1, $6)`,
    [hospital.id, encounterId, patientId, service, `clm-test:${++keys}`, price],
  );
}

let codes = 0;
const dayFrom = hospitalDay;

/** A payer with a plan and a policy on the patient; returns the payer id. */
async function cover(patientId: string, plan: object = {}, agreement?: object) {
  const org = await ok<{ id: string }>(
    await post('/payers', { kind: 'insurer', code: `CP${++codes}`, name: `Claim Payer ${codes}` }),
    201,
  );
  const made = await ok<{ id: string }>(
    await post(`/payers/${org.id}/plans`, {
      code: `CPL${++codes}`,
      name: `Claim Plan ${codes}`,
      coverageMode: 'all_except',
      copayPercent: 10,
      preAuthRequired: false,
      services: [],
      ...plan,
    }),
    201,
  );
  if (agreement) {
    await ok(
      await post(`/payers/${org.id}/rate-agreements`, {
        name: 'Agreed rates',
        effectiveFrom: dayFrom(0),
        discountBp: 0,
        rates: [],
        ...agreement,
      }),
      201,
    );
  }
  await ok(
    await post(`/patients/${patientId}/policies`, {
      planId: made.id,
      policyNumber: `POL-${++codes}`,
      holderName: 'Holder Name',
      relationship: 'self',
      validFrom: dayFrom(-30),
    }),
    201,
  );
  return org.id;
}

const splitOf = async (encounterId: string, options: Options = {}) =>
  ok<Split>(await get(`/encounters/${encounterId}/coverage-split`, options));
const reconciles = (split: Split) =>
  split.lines.every((line) => line.payerMinor + line.patientMinor === line.ratedMinor) &&
  split.lines.reduce((sum, line) => sum + line.payerMinor, 0) === split.payerMinor &&
  split.lines.reduce((sum, line) => sum + line.patientMinor, 0) === split.patientMinor &&
  split.ledgerMinor + split.rateAdjustmentMinor === split.payerMinor + split.patientMinor;

beforeAll(async () => {
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Claims Hospital', { features: allOn });
  clinic = await createTenant(pool, 'Claims Clinic', { features: allOn });
  closed = await createTenant(pool, 'Claims Closed', { features: { insurance: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Claims Admin', { withPassword: false });
  receptionist = await createUser(pool, 'Claims Desk', { withPassword: false });
  nurse = await createUser(pool, 'Claims Nurse', { withPassword: false });
  clinicAdmin = await createUser(pool, 'Claims Clinic Admin', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, receptionist, hospital, 'receptionist');
  await addMembership(pool, nurse, hospital, 'nurse');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  const service = (code: string, name: string) =>
    one(
      `insert into services (tenant_id, code, name, category, tax_class) values ($1, $2, $3, 'procedure', 'exempt') returning id`,
      [hospital.id, code, name],
    );
  serviceA = await service('CLM-A', 'Claim Service A');
  serviceB = await service('CLM-B', 'Claim Service B');
  serviceC = await service('CLM-C', 'Claim Service C');
}, 60_000);

afterAll(async () => {
  try {
    await wipeAll();
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

describe('coverage split', () => {
  it('is 404 without an active policy, and for a visit that does not exist', async () => {
    const { encounterId } = await visit([[serviceA, 1000]]);
    expect(errorOf(await get(`/encounters/${encounterId}/coverage-split`))).toEqual([
      404,
      'no_active_policy',
    ]);
    expect(
      errorOf(await get('/encounters/00000000-0000-4000-8000-000000000000/coverage-split')),
    ).toEqual([404, 'encounter_not_found']);
    expect(errorOf(await get('/encounters/nope/coverage-split'))[1]).toBe('encounter_not_found');
  });

  it('shares each charge out with the co-pay, skipping void charges, and audits the read', async () => {
    const { patientId, encounterId } = await visit([
      [serviceA, 100_001],
      [serviceB, 250_000],
    ]);
    await pool.query(
      `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
         description, quantity, unit_price_minor, status)
       values ($1, $2, $3, $4, 'manual', 'clm-void', 'Voided', 1, 999, 'void')`,
      [hospital.id, encounterId, patientId, serviceA],
    );
    await cover(patientId);
    const split = await splitOf(encounterId);
    expect(split.ledgerMinor).toBe(350_001);
    expect(split.rateAdjustmentMinor).toBe(0);
    // 10% of 100,001 is 10,000.1: rounded half up to whole minor units.
    expect(split.lines.map((line) => [line.payerMinor, line.patientMinor, line.reason])).toEqual([
      [90_001, 10_000, 'copay'],
      [225_000, 25_000, 'copay'],
    ]);
    expect(split.stale).toBe(false);
    expect(split.saved).toBeUndefined();
    expect(reconciles(split)).toBe(true);
    expect(await audited('coverage_split', encounterId)).toEqual(['read']);
  });

  it('prices at the agreed rate or the agreement discount before anything else', async () => {
    const { patientId, encounterId } = await visit([
      [serviceA, 100_000],
      [serviceB, 50_001],
    ]);
    await cover(
      patientId,
      { copayPercent: 0 },
      { discountBp: 1000, rates: [{ serviceId: serviceA, rateMinor: 80_000 }] },
    );
    const split = await splitOf(encounterId);
    expect(split.agreementName).toBe('Agreed rates');
    // A is at its agreed rate; B gets the 10% discount (5,000.1 rounds to 5,000).
    expect(split.lines.map((line) => line.ratedMinor)).toEqual([80_000, 45_001]);
    expect(split.rateAdjustmentMinor).toBe(125_001 - 150_001);
    expect(split.payerMinor).toBe(125_001);
    expect(reconciles(split)).toBe(true);
  });

  it('leaves out what an only-listed plan does not list, and what an all-except plan excludes', async () => {
    const only = await visit([
      [serviceA, 10_000],
      [serviceB, 20_000],
    ]);
    await cover(only.patientId, {
      coverageMode: 'only_listed',
      copayPercent: 0,
      services: [{ serviceId: serviceA }],
    });
    const listed = await splitOf(only.encounterId);
    expect(listed.lines.map((line) => [line.payerMinor, line.reason])).toEqual([
      [10_000, 'covered'],
      [0, 'not_covered'],
    ]);
    expect(listed.patientMinor).toBe(20_000);

    const except = await visit([
      [serviceA, 10_000],
      [serviceB, 20_000],
    ]);
    await cover(except.patientId, {
      copayPercent: 0,
      services: [{ serviceId: serviceB }],
    });
    const excluded = await splitOf(except.encounterId);
    expect(excluded.lines.map((line) => line.reason)).toEqual(['covered', 'not_covered']);
    expect(reconciles(excluded)).toBe(true);
  });

  it('applies the limit per service across charges, then the sum insured in order', async () => {
    const limited = await visit([
      [serviceA, 30_000],
      [serviceA, 30_000],
      [serviceB, 50_000],
    ]);
    await cover(limited.patientId, {
      coverageMode: 'only_listed',
      copayPercent: 0,
      sumInsuredMinor: 70_000,
      services: [{ serviceId: serviceA, limitMinor: 40_000 }, { serviceId: serviceB }],
    });
    const split = await splitOf(limited.encounterId);
    // The first A is covered in full, the second only up to the limit left (10,000), then B is
    // cut to what the sum insured leaves (70,000 - 40,000 = 30,000).
    expect(split.lines.map((line) => [line.payerMinor, line.patientMinor, line.reason])).toEqual([
      [30_000, 0, 'covered'],
      [10_000, 20_000, 'service_limit'],
      [30_000, 20_000, 'sum_insured'],
    ]);
    expect(split.payerMinor).toBe(70_000);
    expect(reconciles(split)).toBe(true);
  });

  it('saves the split, goes stale when the ledger changes, and saves again', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 10_000]]);
    await cover(patientId, { copayPercent: 20 });
    const key = fresh();
    const saved = await ok<Split>(
      await post(`/encounters/${encounterId}/coverage-split`, undefined, { key }),
    );
    expect(saved.saved).toMatchObject({ ledgerMinor: 10_000, payerMinor: 8_000 });
    expect(saved.stale).toBe(false);
    const again = await ok<Split>(
      await post(`/encounters/${encounterId}/coverage-split`, undefined, { key }),
    );
    expect(again.saved).toEqual(saved.saved);

    await charge(encounterId, patientId, serviceA, 5_000);
    const stale = await splitOf(encounterId);
    expect(stale.stale).toBe(true);
    expect(stale.saved?.ledgerMinor).toBe(10_000);
    const resaved = await ok<Split>(
      await post(`/encounters/${encounterId}/coverage-split`, undefined),
    );
    expect(resaved.stale).toBe(false);
    expect(resaved.saved).toMatchObject({ ledgerMinor: 15_000, payerMinor: 12_000 });
    expect(await audited('coverage_split', encounterId)).toContain('update');
  });

  it('needs the permissions, the key, the switch and the hospital', async () => {
    const { patientId, encounterId } = await visit([[serviceA, 10_000]]);
    await cover(patientId);
    expect(
      (await get(`/encounters/${encounterId}/coverage-split`, { user: nurse })).statusCode,
    ).toBe(403);
    expect(
      (await post(`/encounters/${encounterId}/coverage-split`, undefined, { user: nurse }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/encounters/${encounterId}/coverage-split`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await get(`/encounters/${encounterId}/coverage-split`, { user: receptionist })).statusCode,
    ).toBe(200);
    expect(
      errorOf(await get(`/encounters/${encounterId}/coverage-split`, { tenant: closed }))[1],
    ).toBe('feature_disabled');
    // Another hospital cannot see this visit.
    expect(
      errorOf(
        await get(`/encounters/${encounterId}/coverage-split`, {
          tenant: clinic,
          user: clinicAdmin,
        }),
      ),
    ).toEqual([404, 'encounter_not_found']);
  });
});

describe('claims', () => {
  async function claimable(prices: [string, number][] = [[serviceA, 100_000]]) {
    const made = await visit(prices);
    const payerId = await cover(made.patientId, { copayPercent: 0 });
    return { ...made, payerId };
  }
  const create = (encounterId: string, more: object = {}, options: Options = {}) =>
    post(
      `/encounters/${encounterId}/claims`,
      { documents: ['Discharge summary'], ...more },
      options,
    );
  const act = (id: string, body: object, options: Options = {}) =>
    post(`/claims/${id}/actions`, body, options);

  it('prepares a draft from the split: payer share, policy, packet and history', async () => {
    const { patientId, encounterId } = await claimable([
      [serviceA, 100_000],
      [serviceB, 50_000],
    ]);
    const key = fresh();
    const made = await ok<ClaimBody>(
      await create(encounterId, { note: 'First try' }, { key }),
      201,
    );
    expect(made).toMatchObject({
      status: 'draft',
      claimedMinor: 150_000,
      receivedMinor: 0,
      writtenOffMinor: 0,
      outstandingMinor: 0,
      version: 1,
      documents: ['Discharge summary'],
      allowedActions: ['submit', 'cancel'],
    });
    expect(made.number).toMatch(/^CLM-\d{6}$/);
    expect(made.events).toEqual([
      expect.objectContaining({ action: 'create', toStatus: 'draft', note: 'First try' }),
    ]);
    expect(await audited('claim', made.id)).toEqual(['create']);
    // The same key gives the same claim back; a new key finds the open claim.
    const replay = await ok<ClaimBody>(
      await create(encounterId, { note: 'First try' }, { key }),
      201,
    );
    expect(replay.id).toBe(made.id);
    expect(errorOf(await create(encounterId))).toEqual([409, 'claim_exists']);
    const read = await ok<ClaimBody>(await get(`/claims/${made.id}`));
    expect(read.id).toBe(made.id);
    expect(await audited('claim', made.id)).toEqual(['create', 'read']);
    expect(patientId).toBeTruthy();
  });

  it('refuses a claim with nothing to claim, no policy, a missing key and a bad packet', async () => {
    const nothing = await visit([[serviceC, 5_000]]);
    await cover(nothing.patientId, { copayPercent: 0, services: [{ serviceId: serviceC }] });
    expect(errorOf(await create(nothing.encounterId))).toEqual([422, 'nothing_to_claim']);

    const bare = await visit([[serviceA, 5_000]]);
    expect(errorOf(await create(bare.encounterId))).toEqual([404, 'no_active_policy']);

    const { encounterId } = await claimable();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/encounters/${encounterId}/claims`,
          headers: headers(),
          payload: { documents: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await create(encounterId, { documents: ['bad\u0007name'] })).statusCode).toBe(400);
    expect((await create(encounterId, { documents: Array(21).fill('x') })).statusCode).toBe(400);
    expect((await create(encounterId, {}, { user: nurse })).statusCode).toBe(403);
  });

  it('walks submit, query, reply, approve and settle, with events and the outstanding sum', async () => {
    const { encounterId } = await claimable([[serviceA, 400_000]]);
    const draft = await ok<ClaimBody>(await create(encounterId), 201);

    const submitted = await ok<ClaimBody>(
      await act(draft.id, { version: draft.version, action: 'submit', referenceNumber: 'REF-1' }),
    );
    expect(submitted).toMatchObject({
      status: 'submitted',
      outstandingMinor: 400_000,
      allowedActions: ['raise_query', 'approve', 'reject'],
    });
    expect(submitted.submittedAt).toBeTruthy();
    expect(await emitted('claim.submitted', draft.id)).toBe(1);

    // A query needs its question, and keeps the claim waiting for a reply.
    expect(
      errorOf(await act(draft.id, { version: submitted.version, action: 'raise_query' })),
    ).toEqual([422, 'validation_failed']);
    const queried = await ok<ClaimBody>(
      await act(draft.id, {
        version: submitted.version,
        action: 'raise_query',
        note: 'Send the operation notes.',
      }),
    );
    expect(queried).toMatchObject({
      status: 'query',
      openQuery: 'Send the operation notes.',
      allowedActions: ['reply', 'cancel'],
    });
    const replied = await ok<ClaimBody>(
      await act(draft.id, {
        version: queried.version,
        action: 'reply',
        note: 'Sent.',
        documents: ['Operation notes'],
      }),
    );
    expect(replied.status).toBe('submitted');
    expect(replied.openQuery).toBeUndefined();
    expect(replied.documents).toEqual(['Discharge summary', 'Operation notes']);

    expect(
      errorOf(
        await act(draft.id, {
          version: replied.version,
          action: 'approve',
          approvedMinor: 400_001,
        }),
      ),
    ).toEqual([422, 'validation_failed']);
    const approved = await ok<ClaimBody>(
      await act(draft.id, { version: replied.version, action: 'approve', approvedMinor: 350_000 }),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      approvedMinor: 350_000,
      allowedActions: ['settle'],
    });

    expect(
      errorOf(
        await act(draft.id, {
          version: approved.version,
          action: 'settle',
          receivedMinor: 350_001,
        }),
      ),
    ).toEqual([422, 'validation_failed']);
    const settled = await ok<ClaimBody>(
      await act(draft.id, { version: approved.version, action: 'settle', receivedMinor: 300_000 }),
    );
    expect(settled).toMatchObject({
      status: 'settled',
      receivedMinor: 300_000,
      outstandingMinor: 100_000,
      allowedActions: ['write_off'],
    });
    expect(await emitted('claim.settled', draft.id)).toBe(1);
    expect(settled.events.map((event) => event.action)).toEqual([
      'settle',
      'approve',
      'reply',
      'raise_query',
      'submit',
      'create',
    ]);
    expect(await audited('claim', draft.id)).toContain('update');

    // Only a holder of claim:writeoff gives up what is left.
    expect(
      errorOf(
        await act(
          draft.id,
          { version: settled.version, action: 'write_off', note: 'Short paid' },
          { user: receptionist },
        ),
      ),
    ).toEqual([403, 'forbidden']);
    expect(errorOf(await act(draft.id, { version: settled.version, action: 'write_off' }))).toEqual(
      [422, 'validation_failed'],
    );
    const off = await ok<ClaimBody>(
      await act(draft.id, { version: settled.version, action: 'write_off', note: 'Short paid' }),
    );
    expect(off).toMatchObject({
      status: 'written_off',
      writtenOffMinor: 100_000,
      outstandingMinor: 0,
      allowedActions: [],
    });
    expect(off.events[0]).toMatchObject({ action: 'write_off', amountMinor: 100_000 });
  });

  it('refuses every move the state machine does not allow, and a stale version', async () => {
    const { encounterId } = await claimable();
    const draft = await ok<ClaimBody>(await create(encounterId), 201);
    for (const action of ['raise_query', 'reply', 'approve', 'reject', 'settle', 'write_off']) {
      const body = {
        version: draft.version,
        action,
        note: 'x',
        approvedMinor: 1,
        receivedMinor: 1,
      };
      expect(errorOf(await act(draft.id, body)), action).toEqual([409, 'invalid_transition']);
    }
    expect(errorOf(await act(draft.id, { version: 9, action: 'submit' }))).toEqual([
      409,
      'version_conflict',
    ]);
    const submitted = await ok<ClaimBody>(
      await act(draft.id, { version: draft.version, action: 'submit' }),
    );
    for (const action of ['submit', 'reply', 'settle', 'cancel']) {
      expect(
        errorOf(
          await act(draft.id, { version: submitted.version, action, note: 'x', receivedMinor: 1 }),
        ),
        action,
      ).toEqual([409, 'invalid_transition']);
    }
    expect((await act(draft.id, { version: 1, action: 'bogus' })).statusCode).toBe(400);
    expect(errorOf(await act('nope', { version: 1, action: 'submit' }))).toEqual([
      404,
      'claim_not_found',
    ]);
    expect(
      (await act(draft.id, { version: 1, action: 'submit' }, { user: nurse })).statusCode,
    ).toBe(403);
  });

  it('rejects and writes off in full; a cancelled or written-off claim frees the visit', async () => {
    const { encounterId } = await claimable([[serviceA, 80_000]]);
    const draft = await ok<ClaimBody>(await create(encounterId), 201);
    const cancelled = await ok<ClaimBody>(
      await act(draft.id, { version: draft.version, action: 'cancel' }),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      outstandingMinor: 0,
      allowedActions: [],
    });

    const second = await ok<ClaimBody>(await create(encounterId), 201);
    expect(second.id).not.toBe(draft.id);
    const sent = await ok<ClaimBody>(
      await act(second.id, { version: second.version, action: 'submit' }),
    );
    const rejected = await ok<ClaimBody>(
      await act(second.id, { version: sent.version, action: 'reject', note: 'Not covered' }),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      outstandingMinor: 80_000,
      allowedActions: ['write_off'],
    });
    expect(rejected.events[0]).toMatchObject({ action: 'reject', note: 'Not covered' });
    const off = await ok<ClaimBody>(
      await act(second.id, {
        version: rejected.version,
        action: 'write_off',
        note: 'Rejected for good',
      }),
    );
    expect(off).toMatchObject({ status: 'written_off', writtenOffMinor: 80_000 });
    // A claim paid in full has nothing to write off.
    const third = await ok<ClaimBody>(await create(encounterId), 201);
    expect(third.status).toBe('draft');
    const t1 = await ok<ClaimBody>(await act(third.id, { version: 1, action: 'submit' }));
    const t2 = await ok<ClaimBody>(
      await act(third.id, { version: t1.version, action: 'approve', approvedMinor: 80_000 }),
    );
    const t3 = await ok<ClaimBody>(
      await act(third.id, { version: t2.version, action: 'settle', receivedMinor: 80_000 }),
    );
    expect(t3).toMatchObject({ outstandingMinor: 0, allowedActions: [] });
    expect(
      errorOf(await act(third.id, { version: t3.version, action: 'write_off', note: 'x' })),
    ).toEqual([409, 'invalid_transition']);
  });

  it('lists newest first with a filter and a cursor, and ages what is still owed', async () => {
    await wipeAll();
    const claims: ClaimBody[] = [];
    for (const age of [5, 40, 70, 120]) {
      const { encounterId } = await claimable([[serviceA, 100_000]]);
      const draft = await ok<ClaimBody>(await create(encounterId), 201);
      const sent = await ok<ClaimBody>(
        await act(draft.id, { version: draft.version, action: 'submit' }),
      );
      await pool.query(
        `update claims set submitted_at = now() - ($2 || ' days')::interval where id = $1`,
        [sent.id, String(age)],
      );
      claims.push(sent);
    }
    const { encounterId: draftVisit } = await claimable();
    const stillDraft = await ok<ClaimBody>(await create(draftVisit), 201);

    const page = await ok<{ items: ClaimBody[]; nextCursor: string | null; total: number }>(
      await get('/claims?limit=2'),
    );
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.id)).toEqual([stillDraft.id, claims[3]?.id]);
    const rest = await ok<{ items: ClaimBody[]; nextCursor: string | null }>(
      await get(`/claims?limit=10&cursor=${page.nextCursor}`),
    );
    expect(rest.items.map((item) => item.id)).toEqual([2, 1, 0].map((i) => claims[i]?.id));
    expect(rest.nextCursor).toBeNull();
    expect(errorOf(await get('/claims?cursor=garbage'))).toEqual([400, 'invalid_cursor']);
    expect((await get('/claims?status=bogus')).statusCode).toBe(400);
    const drafts = await ok<{ items: ClaimBody[]; total: number }>(
      await get('/claims?status=draft'),
    );
    expect(drafts.items.map((item) => item.id)).toEqual([stillDraft.id]);

    const aging = await ok<{
      rows: { claims: number; buckets: number[]; outstandingMinor: number; payerName: string }[];
      totals: { claims: number; buckets: number[]; outstandingMinor: number };
    }>(await get('/claims/aging'));
    expect(aging.rows).toHaveLength(4);
    expect(aging.totals).toEqual({
      claims: 4,
      buckets: [100_000, 100_000, 100_000, 100_000],
      outstandingMinor: 400_000,
    });
    for (const row of aging.rows) {
      expect(row.buckets.reduce((a, b) => a + b, 0)).toBe(row.outstandingMinor);
    }
  });

  it('keeps claims inside the hospital and behind the permissions and the switch', async () => {
    const { encounterId } = await claimable();
    const made = await ok<ClaimBody>(await create(encounterId), 201);
    expect(errorOf(await get(`/claims/${made.id}`, { tenant: clinic, user: clinicAdmin }))).toEqual(
      [404, 'claim_not_found'],
    );
    const theirs = await ok<{ items: unknown[]; total: number }>(
      await get('/claims', { tenant: clinic, user: clinicAdmin }),
    );
    expect(theirs).toMatchObject({ items: [], total: 0 });
    const aging = await ok<{ totals: { claims: number } }>(
      await get('/claims/aging', { tenant: clinic, user: clinicAdmin }),
    );
    expect(aging.totals.claims).toBe(0);
    expect(
      errorOf(
        await act(made.id, { version: 1, action: 'submit' }, { tenant: clinic, user: clinicAdmin }),
      ),
    ).toEqual([404, 'claim_not_found']);
    expect(errorOf(await create(encounterId, {}, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'encounter_not_found',
    ]);
    expect((await get('/claims', { user: nurse })).statusCode).toBe(403);
    expect(errorOf(await get('/claims', { tenant: closed }))[1]).toBe('feature_disabled');
    for (const table of ['claims', 'claim_events', 'claim_counters', 'coverage_splits']) {
      await asTenantSql(pool, clinic.id, async (client) => {
        const { rows } = await client.query(`select 1 from ${table}`);
        expect(rows, table).toHaveLength(0);
      });
    }
  });

  it('is guarded by the database itself', async () => {
    const { encounterId } = await claimable();
    const made = await ok<ClaimBody>(await create(encounterId), 201);
    const asHospital = <T>(run: (client: pg.PoolClient) => Promise<T>) =>
      asTenantSql(pool, hospital.id, run);
    // What was claimed and for which visit never changes.
    await expect(
      asHospital((client) =>
        client.query('update claims set claimed_minor = 1 where id = $1', [made.id]),
      ),
    ).rejects.toThrow(/do not change/);
    // The money stays within what was claimed.
    await expect(
      asHospital((client) =>
        client.query('update claims set approved_minor = 5, received_minor = 6 where id = $1', [
          made.id,
        ]),
      ),
    ).rejects.toThrow(/claims_paid_within_approved/);
    // History is append-only.
    await expect(
      asHospital((client) =>
        client.query("update claim_events set note = 'x' where claim_id = $1", [made.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asHospital((client) =>
        client.query('delete from claim_events where claim_id = $1', [made.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    // One claim in play per visit, whatever the application checks.
    await expect(
      asHospital((client) =>
        client.query(
          `insert into claims (seq, patient_id, encounter_id, policy_id, payer_id, policy_number,
             claimed_minor, created_by)
           select 9999, patient_id, encounter_id, policy_id, payer_id, policy_number, 1, created_by
             from claims where id = $1`,
          [made.id],
        ),
      ),
    ).rejects.toThrow(/claims_one_open_per_visit/);
    // A query status carries its question.
    await expect(
      asHospital((client) =>
        client.query("update claims set status = 'query' where id = $1", [made.id]),
      ),
    ).rejects.toThrow(/claims_query_open/);
  });
});
