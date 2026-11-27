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
  resolveTestSession,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { MemoryQueue } from '../../core/jobs/queue.js';

/**
 * Voiding a pending charge and discarding a draft invoice (#1240), through the real app and
 * database. Split pairs and claims are in `insurance/split-invoices.test.ts`.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let jobs: MemoryQueue;
let hospital: TestTenant;
let clinic: TestTenant;
/** Billing switched off. */
let closed: TestTenant;
let admin: TestUser;
let desk: TestUser;
let doctor: TestUser;
let clinicAdmin: TestUser;
let patientId: string;

interface Options {
  tenant?: TestTenant;
  user?: TestUser;
  key?: string;
}
type Reply = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Invoice {
  id: string;
  status: string;
  number?: string;
  version: number;
  totalMinor: number;
  lines: { chargeId?: string }[];
  discardedAt?: string;
  discardReason?: string;
  discardedByName?: string;
}
interface Charge {
  id: string;
  status: string;
  invoiceId?: string;
  voidedAt?: string;
  voidReason?: string;
}

const headers = ({ tenant = hospital, user = admin, key = randomUUID() }: Options = {}) => ({
  ...as(tenant.id, user.id),
  'idempotency-key': key,
});
const get = (url: string, options: Options = {}) => app.inject({ url, headers: headers(options) });
const post = (url: string, payload: object, options: Options = {}) =>
  app.inject({ method: 'POST', url, headers: headers(options), payload });
const errorOf = (response: Reply) => [
  response.statusCode,
  response.json<{ error: { code: string } }>().error.code,
];
async function ok<Body>(response: Reply | Promise<Reply>, status = 200): Promise<Body> {
  const reply = await response;
  if (reply.statusCode !== status) {
    throw new Error(`expected ${status}, got ${reply.statusCode}: ${reply.body}`);
  }
  return reply.json<Body>();
}

const one = async (sql: string, params: unknown[]) =>
  ((await pool.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;

const addEncounter = (tenant: TestTenant = hospital, patient = patientId, by = admin) =>
  one(
    `insert into encounters (tenant_id, patient_id, type, opened_by)
     values ($1, $2, 'opd', $3) returning id`,
    [tenant.id, patient, by.id],
  );

let sources = 0;
const addCharge = (
  encounterId: string,
  { source = 'service', serviceId = null as string | null, flag = null as string | null } = {},
) =>
  one(
    `insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
       description, quantity, unit_price_minor, flag)
     values ($1, $2, $3, $4, $5, $6, 'Charge', 1, 10000, $7) returning id`,
    [hospital.id, encounterId, patientId, serviceId, source, `vd:${++sources}`, flag],
  );

const voidCharge = (id: string, body: object = { reason: 'duplicate' }, options: Options = {}) =>
  post(`/charges/${id}/void`, body, options);
const draftOf = (encounterId: string, chargeIds: string[]) =>
  ok<Invoice>(post(`/encounters/${encounterId}/invoices`, { chargeIds, manualLines: [] }), 201);
const discard = (invoice: Invoice, options: Options = {}, version = invoice.version) =>
  post(`/invoices/${invoice.id}/discard`, { version, reason: 'made_in_error' }, options);

const rowsOf = async (encounterId: string) =>
  (
    await pool.query<{
      id: string;
      status: string;
      invoice_id: string | null;
      flag: string | null;
    }>('select id, status, invoice_id, flag from charges where encounter_id = $1', [encounterId])
  ).rows;
const audited = async (entityId: string) =>
  (
    await pool.query<{ action: string; detail: string | null }>(
      `select action, detail from audit_log
       where tenant_id = $1 and entity_id = $2 and action in ('void', 'discard')`,
      [hospital.id, entityId],
    )
  ).rows;
const emitted = async (entityId: string, event: string) =>
  (
    await pool.query(
      'select 1 from outbox where tenant_id = $1 and entity_id = $2 and event = $3',
      [hospital.id, entityId, event],
    )
  ).rowCount;

let services = 0;
async function addService(category = 'imaging') {
  const code = `VD-${++services}`;
  const id = await one(
    `insert into services (tenant_id, code, name, category, tax_class)
     values ($1, $2, $2, $3, 'exempt') returning id`,
    [hospital.id, code, category],
  );
  await pool.query(
    `insert into service_prices (tenant_id, service_id, price_list_id, amount_minor, effective_from)
     select $1, $2, id, 5000, current_date - 10 from price_lists where tenant_id = $1 and standard`,
    [hospital.id, id],
  );
  return id;
}

async function publish(event: string, entityId: string, payload: object) {
  await pool.query(
    `insert into outbox (tenant_id, event, entity_id, actor_id, payload)
     values ($1, $2, $3, null, $4)`,
    [hospital.id, event, entityId, JSON.stringify(payload)],
  );
  await app.events.dispatch();
  await jobs.drain();
}

beforeAll(async () => {
  jobs = new MemoryQueue();
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: jobs,
    config: { RATE_LIMIT_USER_PER_MINUTE: 100_000, RATE_LIMIT_TENANT_PER_MINUTE: 100_000 },
  });
  pool = app.database.pool;
  const features = { patients: true, clinical: true, services: true, billing: true };
  hospital = await createTenant(pool, 'Void Hospital', { features });
  clinic = await createTenant(pool, 'Void Clinic', { features });
  closed = await createTenant(pool, 'Void Closed', { features: { ...features, billing: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Void Admin');
  desk = await user('Void Desk');
  doctor = await user('Void Doctor');
  clinicAdmin = await user('Void Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, doctor, hospital, 'doctor');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  patientId = await one(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, 'VD-0000001', 'Asha', 'Test', '1980-05-01', 'female', '+91 9800000000', 'test')
     returning id`,
    [hospital.id],
  );
}, 60_000);

afterAll(async () => {
  const ids = [hospital.id, clinic.id, closed.id];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'invoice_lines',
      'charges',
      'invoices',
      'invoice_counters',
      'package_items',
      'service_prices',
      'services',
      'encounters',
      'patients',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [ids]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, clinic, closed]);
  await deleteUsers(pool, [admin, desk, doctor, clinicAdmin]);
  await app.close();
});

describe('voiding a charge', () => {
  it('voids a pending charge once, with who, when and why, audited and emitted', async () => {
    const visit = await addEncounter();
    const id = await addCharge(visit, { flag: 'return_review' });
    const key = randomUUID();
    const voided = await ok<Charge>(voidCharge(id, { reason: 'not_performed' }, { key }));
    expect(voided).toMatchObject({ status: 'void', voidReason: 'not_performed' });
    expect(voided.voidedAt).toBeDefined();
    expect(voided).not.toHaveProperty('flag');
    expect(await ok<Charge>(voidCharge(id, { reason: 'not_performed' }, { key }))).toEqual(voided);
    expect(errorOf(await voidCharge(id))).toEqual([409, 'charge_not_pending']);
    const { rows } = await pool.query('select voided_by from charges where id = $1', [id]);
    expect(rows).toEqual([{ voided_by: admin.id }]);
    expect(await audited(id)).toEqual([{ action: 'void', detail: 'not_performed' }]);
    expect(await emitted(id, 'charge.voided')).toBe(1);
    // Why it was voided is written once, even for the owner.
    await expect(
      pool.query("update charges set void_reason = 'other' where id = $1", [id]),
    ).rejects.toThrow(/never changed/);
  });

  it('refuses a charge on a draft or an issued invoice, and a reason that is not listed', async () => {
    const visit = await addEncounter();
    const id = await addCharge(visit);
    expect((await voidCharge(id, { reason: 'because' })).statusCode).toBe(400);
    expect((await voidCharge(id, {})).statusCode).toBe(400);
    const draft = await draftOf(visit, [id]);
    expect(errorOf(await voidCharge(id))).toEqual([409, 'charge_on_draft']);
    await ok(post(`/invoices/${draft.id}/issue`, { version: draft.version }));
    expect(errorOf(await voidCharge(id))).toEqual([409, 'charge_not_pending']);
    expect(errorOf(await voidCharge(randomUUID()))).toEqual([404, 'charge_not_found']);
  });

  it('needs charge:void, the billing switch and a key, and stays in its hospital', async () => {
    const visit = await addEncounter();
    const id = await addCharge(visit);
    for (const user of [desk, doctor]) {
      expect((await voidCharge(id, undefined, { user })).statusCode).toBe(403);
    }
    expect(errorOf(await voidCharge(id, undefined, { tenant: closed }))).toEqual([
      403,
      'feature_disabled',
    ]);
    expect(errorOf(await voidCharge(id, undefined, { tenant: clinic, user: clinicAdmin }))).toEqual(
      [404, 'charge_not_found'],
    );
    const keyless = await app.inject({
      method: 'POST',
      url: `/charges/${id}/void`,
      headers: as(hospital.id, admin.id),
      payload: { reason: 'duplicate' },
    });
    expect(keyless.statusCode).toBe(400);
    expect(await rowsOf(visit)).toMatchObject([{ status: 'pending' }]);
    // The database keeps another hospital away from the row too.
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query('select 1 from charges where id = $1', [id]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('lets a void or a new draft have a charge, never both', async () => {
    for (let round = 0; round < 5; round += 1) {
      const visit = await addEncounter();
      const id = await addCharge(visit);
      const [voided, drafted] = await Promise.all([
        voidCharge(id),
        post(`/encounters/${visit}/invoices`, { chargeIds: [id], manualLines: [] }),
      ]);
      const [row] = await rowsOf(visit);
      if (voided.statusCode === 200) {
        expect(errorOf(drafted)).toEqual([409, 'charge_unavailable']);
        expect(row).toMatchObject({ status: 'void', invoice_id: null });
      } else {
        expect(drafted.statusCode).toBe(201);
        expect(errorOf(voided)).toEqual([409, 'charge_on_draft']);
        expect(row?.status).toBe('pending');
      }
    }
  });

  it('is not posted again when the event that posted it repeats', async () => {
    const visit = await addEncounter();
    const serviceId = await addService();
    const orderId = randomUUID();
    const payload = { encounterId: visit, patientId, type: 'imaging', serviceId };
    await publish('order.completed', orderId, payload);
    const [posted] = await rowsOf(visit);
    await ok(voidCharge(posted?.id ?? '', { reason: 'entered_in_error' }));
    await publish('order.completed', orderId, payload);
    expect(await rowsOf(visit)).toMatchObject([{ id: posted?.id, status: 'void' }]);
  });

  it('voids a package that covers other charges only once confirmed, and they stay void', async () => {
    const visit = await addEncounter();
    const included = await addService();
    const bundle = await addService('package');
    await pool.query(
      `insert into package_items (tenant_id, package_service_id, service_id, kind)
       values ($1, $2, $3, 'included')`,
      [hospital.id, bundle, included],
    );
    const covered = await addCharge(visit, { serviceId: included });
    const applied = await ok<Charge>(
      post(`/encounters/${visit}/packages`, { serviceId: bundle }),
      201,
    );
    expect(errorOf(await voidCharge(covered))).toEqual([409, 'charge_not_pending']);
    expect(errorOf(await voidCharge(applied.id))).toEqual([409, 'covers_charges']);
    expect(
      errorOf(await voidCharge(applied.id, { reason: 'other', confirmCovered: false })),
    ).toEqual([409, 'covers_charges']);
    await ok(voidCharge(applied.id, { reason: 'other', confirmCovered: true }));
    expect((await rowsOf(visit)).map((row) => row.status)).toEqual(['void', 'void']);
    expect(await audited(applied.id)).toEqual([
      { action: 'void', detail: 'other, covered charges confirmed' },
    ]);
    // Work posted afterwards is billed on its own again.
    await publish('order.completed', randomUUID(), {
      encounterId: visit,
      patientId,
      type: 'imaging',
      serviceId: included,
    });
    expect((await rowsOf(visit)).filter((row) => row.status === 'pending')).toHaveLength(1);
  });
});

describe('discarding a draft', () => {
  it('voids it with no number, keeps its lines and releases its charges, once', async () => {
    const visit = await addEncounter();
    const charges = [await addCharge(visit), await addCharge(visit)];
    const draft = await draftOf(visit, charges);
    const key = randomUUID();
    const gone = await ok<Invoice>(discard(draft, { user: desk, key }));
    expect(gone).toMatchObject({
      status: 'void',
      discardReason: 'made_in_error',
      discardedByName: 'Void Desk',
      version: draft.version + 1,
    });
    expect(gone.number).toBeUndefined();
    expect(gone.discardedAt).toBeDefined();
    expect(gone.lines.map((line) => line.chargeId)).toEqual(charges);
    expect((await rowsOf(visit)).map((row) => [row.status, row.invoice_id])).toEqual([
      ['pending', null],
      ['pending', null],
    ]);
    expect(await ok<Invoice>(discard(draft, { user: desk, key }))).toEqual(gone);
    expect(await audited(draft.id)).toEqual([{ action: 'discard', detail: 'made_in_error' }]);
    expect(await emitted(draft.id, 'invoice.discarded')).toBe(1);

    // It stays as history: not changed, issued, printed, paid or approved.
    expect(errorOf(await discard(gone))).toEqual([409, 'invoice_not_draft']);
    expect(errorOf(await post(`/invoices/${draft.id}/issue`, { version: gone.version }))).toEqual([
      409,
      'invoice_not_draft',
    ]);
    expect(errorOf(await post(`/invoices/${draft.id}/print`, {}))).toEqual([409, 'not_printable']);
    expect(
      errorOf(await post(`/invoices/${draft.id}/payments`, { amountMinor: 1, method: 'card' })),
    ).toEqual([409, 'invoice_not_payable']);
    await expect(
      pool.query('update invoices set total_minor = 0 where id = $1', [draft.id]),
    ).rejects.toThrow(/never changed|does not go back/);
    await expect(
      pool.query('delete from invoice_lines where invoice_id = $1', [draft.id]),
    ).rejects.toThrow(/never changed/);
    // The charges go on another bill.
    await draftOf(visit, charges);
  });

  it('discards a draft whose discount waits for approval', async () => {
    const visit = await addEncounter();
    const id = await addCharge(visit);
    const draft = await ok<Invoice>(
      post(`/encounters/${visit}/invoices`, {
        chargeIds: [id],
        manualLines: [],
        billDiscount: { kind: 'percent', value: 5000, reason: 'charity' },
      }),
      201,
    );
    expect(await ok<Invoice>(discard(draft))).toMatchObject({ status: 'void' });
  });

  it('refuses a stale version and an issued invoice', async () => {
    const visit = await addEncounter();
    const draft = await draftOf(visit, [await addCharge(visit)]);
    expect(errorOf(await discard(draft, {}, draft.version + 1))).toEqual([409, 'version_conflict']);
    const issued = await ok<Invoice>(
      post(`/invoices/${draft.id}/issue`, { version: draft.version }),
    );
    expect(errorOf(await discard(issued))).toEqual([409, 'invoice_not_draft']);
  });

  it('needs invoice:discard and the billing switch, and stays in its hospital', async () => {
    const visit = await addEncounter();
    const draft = await draftOf(visit, [await addCharge(visit)]);
    expect((await discard(draft, { user: doctor })).statusCode).toBe(403);
    expect(errorOf(await discard(draft, { tenant: closed }))).toEqual([403, 'feature_disabled']);
    expect(errorOf(await discard(draft, { tenant: clinic, user: clinicAdmin }))).toEqual([
      404,
      'invoice_not_found',
    ]);
    expect(await ok<Invoice>(get(`/invoices/${draft.id}`))).toMatchObject({ status: 'draft' });
  });

  it('lets an issue or a discard win, never both', async () => {
    for (let round = 0; round < 5; round += 1) {
      const visit = await addEncounter();
      const draft = await draftOf(visit, [await addCharge(visit)]);
      const [issue, gone] = await Promise.all([
        post(`/invoices/${draft.id}/issue`, { version: draft.version }),
        discard(draft),
      ]);
      expect([issue.statusCode, gone.statusCode].sort()).toEqual([200, 409]);
      expect((await rowsOf(visit))[0]?.status).toBe(
        issue.statusCode === 200 ? 'invoiced' : 'pending',
      );
    }
  });

  it('lets the visit be cancelled once the draft is discarded and its charge voided', async () => {
    const visit = await addEncounter();
    const id = await addCharge(visit);
    const draft = await draftOf(visit, [id]);
    const cancel = () =>
      post(`/encounters/${visit}/cancel`, { version: 1, reason: 'Opened by mistake' });
    expect((await cancel()).statusCode).toBe(409);
    await ok(discard(draft));
    expect((await cancel()).statusCode).toBe(409);
    await ok(voidCharge(id));
    await ok(cancel());
  });
});
