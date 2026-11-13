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

/** Collected on a date from the payments, by method, on the hospital's clock (#726). */

let app: FastifyInstance;
let pool: pg.Pool;
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let desk: TestUser;
let clinicAdmin: TestUser;

interface Collected {
  date: string;
  timezone: string;
  totals: { method: string; paidMinor: number; refundedMinor: number }[];
  netMinor: number;
}

const get = (url: string, tenant: TestTenant, user: TestUser) =>
  app.inject({ url, headers: as(tenant.id, user.id) });

/** A payment row put straight into the ledger at an exact instant, on a new issued invoice. */
async function pay(
  tenant: TestTenant,
  by: TestUser,
  method: string,
  kind: 'payment' | 'refund',
  amount: number,
  at: string,
) {
  const { rows: patient } = await pool.query<{ id: string }>(
    `insert into patients (tenant_id, mrn, first_name, last_name, dob, gender, phone, created_by)
     values ($1, $2, 'Col', 'Lected', '1990-01-01', 'female', '+91 9800000000', 'test') returning id`,
    [tenant.id, `CT-${randomUUID().slice(0, 8)}`],
  );
  const { rows: encounter } = await pool.query<{ id: string }>(
    `insert into encounters (tenant_id, patient_id, type, opened_by)
     values ($1, $2, 'opd', $3) returning id`,
    [tenant.id, patient[0]?.id, by.id],
  );
  const { rows: invoice } = await pool.query<{ id: string }>(
    `insert into invoices (tenant_id, encounter_id, patient_id, status, currency, created_by)
     values ($1, $2, $3, 'draft', 'INR', $4) returning id`,
    [tenant.id, encounter[0]?.id, patient[0]?.id, by.id],
  );
  const invoiceId = invoice[0]?.id;
  const { rows: first } = await pool.query<{ id: string }>(
    `insert into payments (tenant_id, invoice_id, kind, amount_minor, method, recorded_by, at)
     values ($1, $2, 'payment', $3, $4, $5, $6) returning id`,
    [tenant.id, invoiceId, kind === 'refund' ? amount * 2 : amount, method, by.id, at],
  );
  if (kind === 'refund') {
    await pool.query(
      `insert into payments (tenant_id, invoice_id, kind, amount_minor, method, refund_of, reason, recorded_by, at)
       values ($1, $2, 'refund', $3, $4, $5, 'test', $6, $7)`,
      [tenant.id, invoiceId, amount, method, first[0]?.id, by.id, at],
    );
  }
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession });
  pool = app.database.pool;
  const features = { patients: true, clinical: true, services: true, billing: true };
  hospital = await createTenant(pool, 'Collected Hospital', { features });
  clinic = await createTenant(pool, 'Collected Clinic', { features });
  await pool.query(`update tenants set timezone = 'Asia/Kolkata' where id = $1`, [hospital.id]);
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  const user = (name: string) => createUser(pool, name, { withPassword: false });
  admin = await user('Collected Admin');
  desk = await user('Collected Desk');
  clinicAdmin = await user('Collected Clinic Admin');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, desk, hospital, 'doctor');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    for (const table of ['payments', 'invoices', 'encounters', 'patients']) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteTenants(pool, [hospital, clinic]);
  await deleteUsers(pool, [admin, desk, clinicAdmin]);
  await app.close();
});

describe('collected on a date', () => {
  it('sums by method, net of refunds, on the hospital’s day', async () => {
    // 2026-03-10 in Kolkata is 18:30 UTC on the 9th to 18:30 UTC on the 10th.
    await pay(hospital, admin, 'upi', 'payment', 1_000, '2026-03-09T18:29:59Z'); // the 9th
    await pay(hospital, admin, 'upi', 'payment', 2_000, '2026-03-09T18:30:00Z'); // first instant
    await pay(hospital, admin, 'card', 'payment', 500, '2026-03-10T10:00:00Z');
    await pay(hospital, admin, 'upi', 'refund', 300, '2026-03-10T18:29:59Z'); // last instant
    await pay(hospital, admin, 'bank', 'payment', 7_000, '2026-03-10T18:30:00Z'); // the 11th
    const response = await get('/cash-registers/collected?date=2026-03-10', hospital, admin);
    expect(response.statusCode).toBe(200);
    const body = response.json<Collected>();
    expect(body.date).toBe('2026-03-10');
    expect(body.timezone).toBe('Asia/Kolkata');
    expect(body.totals).toEqual([
      { method: 'card', paidMinor: 500, refundedMinor: 0 },
      { method: 'upi', paidMinor: 2_600, refundedMinor: 300 },
    ]);
    expect(body.netMinor).toBe(500 + 2_600 - 300);
  });

  it('answers today, empty, when nothing was taken', async () => {
    const response = await get('/cash-registers/collected', clinic, clinicAdmin);
    expect(response.statusCode).toBe(200);
    const body = response.json<Collected>();
    expect(body.totals).toEqual([]);
    expect(body.netMinor).toBe(0);
  });

  it('never counts another hospital’s payments', async () => {
    await pay(clinic, clinicAdmin, 'upi', 'payment', 9_999, '2026-03-10T10:00:00Z');
    const mine = await get('/cash-registers/collected?date=2026-03-10', clinic, clinicAdmin);
    expect(mine.json<Collected>().netMinor).toBe(9_999);
    const other = await get('/cash-registers/collected?date=2026-03-10', hospital, admin);
    expect(other.json<Collected>().netMinor).toBe(500 + 2_600 - 300);
  });

  it('needs cashRegister:read and a valid date', async () => {
    expect((await get('/cash-registers/collected', hospital, desk)).statusCode).toBe(403);
    expect(
      (await get('/cash-registers/collected?date=2026-13-45', hospital, admin)).statusCode,
    ).toBe(400);
    expect((await get('/cash-registers/collected?date=today', hospital, admin)).statusCode).toBe(
      400,
    );
  });
});
