import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileStore } from '../../core/files/store.js';
import { signDownload, verifyDownload } from '../../core/files/signing.js';
import { makeTestFileStore, type TestFileStore } from '../../../test/file-store.js';
import { MemoryQueue } from '../../core/jobs/queue.js';
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
  testConfig,
  type TestTenant,
  type TestUser,
} from '../../../test/helpers.js';
import { toCsv } from './csv.js';
import { ReportGate } from './gate.js';
import { fileKeyOf, runReport, sweepReports } from './jobs.js';
import type { ReportResult } from './schemas.js';

/**
 * Reports through the real app and database: the four reports with their numbers, the hospital's
 * own clock, the replica pool, permissions and the module flag, stored reports made by a job with
 * a file and a signed link, the quota, the retention sweep and the hospital boundary.
 */

let app: FastifyInstance;
let pool: pg.Pool;
let files: TestFileStore;
let store: FileStore;
const queue = new MemoryQueue();
let hospital: TestTenant;
let clinic: TestTenant;
let closed: TestTenant;
let admin: TestUser;
let clinicAdmin: TestUser;
let desk: TestUser;

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const errorCode = (response: Response) => response.json<{ error: { code: string } }>().error.code;

const headers = (tenant: TestTenant, user: TestUser) => as(tenant.id, user.id);
const runSync = (kind: string, body: object, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url: `/reports/${kind}`,
    headers: headers(tenant, user),
    payload: body,
  });
const createRun = (kind: string, body: object, key: string, tenant = hospital, user = admin) =>
  app.inject({
    method: 'POST',
    url: `/reports/${kind}/runs`,
    headers: { ...headers(tenant, user), 'idempotency-key': key },
    payload: body,
  });
const get = (url: string, tenant = hospital, user = admin) =>
  app.inject({ url, headers: headers(tenant, user) });

const MARCH_10 = { from: '2026-03-10', to: '2026-03-10' };

/** Runs `work` on the owner connection with constraints and triggers off, to plant source rows. */
async function plant(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await work(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function plantHospitalData(tenant: TestTenant, by: TestUser, scale: number): Promise<void> {
  await plant(async (client) => {
    const department = randomUUID();
    await client.query('insert into departments (id, tenant_id, name) values ($1, $2, $3)', [
      department,
      tenant.id,
      'Cardiology',
    ]);
    // One doctor, attending the OPD visits and booked for appointments below.
    const doctor = randomUUID();
    await client.query(
      `insert into doctors (id, tenant_id, user_id, department_id, specialization, consultation_minutes)
       values ($1, $2, $3, $4, 'Cardiology', 15)`,
      [doctor, tenant.id, by.id, department],
    );
    // Three OPD visits on the 10th at the hospital (Asia/Kolkata), the third at 01:30 local,
    // which is still the 9th in UTC. A visit on the 12th and an inpatient stay do not count.
    const encounter = (type: string, openedAt: string, status = 'open') => {
      const ended = status === 'open' ? null : openedAt;
      return client.query(
        `insert into encounters (tenant_id, patient_id, type, status, department_id, opened_at,
                                 opened_by, ended_at, ended_by, cancel_reason, attending_doctor_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenant.id,
          randomUUID(),
          type,
          status,
          department,
          openedAt,
          by.id,
          ended,
          ended ? by.id : null,
          status === 'cancelled' ? 'entered_in_error' : null,
          doctor,
        ],
      );
    };
    for (let i = 0; i < scale; i++) {
      await encounter('opd', '2026-03-10T10:00:00+05:30');
      await encounter('opd', '2026-03-10T11:00:00+05:30', 'closed');
      await encounter('opd', '2026-03-09T20:00:00Z', 'cancelled');
    }
    await encounter('opd', '2026-03-12T10:00:00+05:30');
    await encounter('ipd', '2026-03-10T10:00:00+05:30');

    // Appointments: on the 10th two completed, one no-show and one still scheduled; one on the 12th.
    const appointment = (startsAt: string, status: string) =>
      client.query(
        `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, status,
                                   cancel_reason, created_by)
         values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '15 minutes', $5, null, 'test')`,
        [tenant.id, randomUUID(), doctor, startsAt, status],
      );
    await appointment('2026-03-10T09:00:00+05:30', 'completed');
    await appointment('2026-03-10T09:30:00+05:30', 'completed');
    await appointment('2026-03-10T10:00:00+05:30', 'no_show');
    await appointment('2026-03-10T10:30:00+05:30', 'scheduled');
    await appointment('2026-03-12T09:00:00+05:30', 'completed');
    await client.query(
      `update appointments set status = 'cancelled', cancel_reason = 'hospital'
       where tenant_id = $1 and starts_at = '2026-03-10T10:30:00+05:30'`,
      [tenant.id],
    );

    // Pharmacy: on the 10th sales of 1,000 and 500 and a return of 200, and dispenses of 3 and 4
    // units; a sale on the 12th does not count.
    const shop = randomUUID();
    const sale = async (total: number, at: string) => {
      const id = randomUUID();
      await client.query(
        `insert into pharmacy_sales (id, tenant_id, location_id, total_minor, sold_by, sold_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, tenant.id, shop, total * scale, by.id, at],
      );
      return id;
    };
    const first = await sale(1_000, '2026-03-10T10:00:00+05:30');
    await sale(500, '2026-03-10T15:00:00+05:30');
    await sale(900, '2026-03-12T10:00:00+05:30');
    await client.query(
      `insert into pharmacy_sale_returns (tenant_id, sale_id, reason, total_minor, returned_by,
                                          returned_at)
       values ($1, $2, 'Wrong strength', $3, $4, '2026-03-10T16:00:00+05:30')`,
      [tenant.id, first, 200 * scale, by.id],
    );
    const dispensed: string[] = [];
    for (const quantity of [3, 4]) {
      const drugId = randomUUID();
      const dispenseId = randomUUID();
      dispensed.push(dispenseId);
      await client.query(
        `insert into dispenses (id, tenant_id, order_id, prescription_id, encounter_id, patient_id,
                                location_id, prescribed_drug_id, drug_id, item_name, schedule,
                                controlled, quantity, dispensed_by, dispensed_at)
         values ($10, $1, $2, $3, $4, $5, $6, $7, $7, 'Paracetamol', 'none', false, $8, $9,
                 '2026-03-10T11:00:00+05:30')`,
        [
          tenant.id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          shop,
          drugId,
          quantity * scale,
          by.id,
          dispenseId,
        ],
      );
    }

    // One unit of the first dispense is brought back on the 10th, and nets off the units.
    const dispenseReturn = randomUUID();
    await client.query(
      `insert into dispense_returns (id, tenant_id, dispense_id, reason, returned_by, returned_at)
       values ($1, $2, $3, 'Not needed', $4, '2026-03-10T17:00:00+05:30')`,
      [dispenseReturn, tenant.id, dispensed[0], by.id],
    );
    await client.query(
      `insert into dispense_return_lines (tenant_id, return_id, dispense_id, batch_id, quantity,
                                         wasted, ledger_entry_id)
       values ($1, $2, $3, $4, $5, false, $6)`,
      [tenant.id, dispenseReturn, dispensed[0], randomUUID(), scale, randomUUID()],
    );

    // Money on the 10th: two issued invoices, a void one and a draft that do not count.
    const invoice = async (status: string, total: number) => {
      const id = randomUUID();
      const issued = status === 'draft' ? null : '2026-03-10T12:00:00+05:30';
      await client.query(
        `insert into invoices (id, tenant_id, encounter_id, patient_id, number, fiscal_year, status,
                               total_minor, currency, created_by, issued_at, issued_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'INR', $9, $10, $11)`,
        [
          id,
          tenant.id,
          randomUUID(),
          randomUUID(),
          status === 'draft' ? null : `INV-${id.slice(0, 8)}`,
          status === 'draft' ? null : '2025-26',
          status,
          total,
          by.id,
          issued,
          issued ? by.id : null,
        ],
      );
      return id;
    };
    const paid = await invoice('paid', 10_000 * scale);
    await invoice('issued', 5_000 * scale);
    await invoice('void', 99_999);
    await invoice('draft', 77_777);
    const payment = randomUUID();
    await client.query(
      `insert into payments (id, tenant_id, invoice_id, kind, amount_minor, method, recorded_by, at)
       values ($1, $2, $3, 'payment', $4, 'upi', $5, '2026-03-10T14:00:00+05:30')`,
      [payment, tenant.id, paid, 12_000 * scale, by.id],
    );
    await client.query(
      `insert into payments (tenant_id, invoice_id, kind, amount_minor, method, refund_of, reason,
                             recorded_by, at)
       values ($1, $2, 'refund', $3, 'upi', $4, 'overcharged', $5, '2026-03-10T15:00:00+05:30')`,
      [tenant.id, paid, 2_000 * scale, payment, by.id],
    );
    // The next day the issued invoice is part paid in cash through a register session that
    // is settled with exactly that cash: opening 1,000, expected 1,000 + 3,000.
    const session = randomUUID();
    await client.query(
      `insert into cash_register_sessions (id, tenant_id, opened_by, opened_at, opening_minor,
                                           closed_by, closed_at, expected_minor, counted_minor)
       values ($1, $2, $3, '2026-03-11T09:00:00+05:30', $4, $3, '2026-03-11T18:00:00+05:30', $5, $5)`,
      [session, tenant.id, by.id, 1_000 * scale, 4_000 * scale],
    );
    await client.query(
      `insert into payments (tenant_id, invoice_id, kind, amount_minor, method, session_id,
                             recorded_by, at)
       select $1, id, 'payment', $2, 'cash', $3, $4, '2026-03-11T11:00:00+05:30'
       from invoices where tenant_id = $1 and status = 'issued'`,
      [tenant.id, 3_000 * scale, session, by.id],
    );
    // A session that spans midnight: opened on the 12th, closed on the 13th, cash on both days.
    const night = randomUUID();
    await client.query(
      `insert into cash_register_sessions (id, tenant_id, opened_by, opened_at, opening_minor,
                                           closed_by, closed_at, expected_minor, counted_minor)
       values ($1, $2, $3, '2026-03-12T22:00:00+05:30', 0, $3, '2026-03-13T02:00:00+05:30', $4, $4)`,
      [night, tenant.id, by.id, 1_000 * scale],
    );
    for (const [at, amount] of [
      ['2026-03-12T23:00:00+05:30', 700],
      ['2026-03-13T01:00:00+05:30', 300],
    ] as const) {
      await client.query(
        `insert into payments (tenant_id, invoice_id, kind, amount_minor, method, session_id,
                               recorded_by, at)
         values ($1, $2, 'payment', $3, 'cash', $4, $5, $6)`,
        [tenant.id, paid, amount * scale, night, by.id, at],
      );
    }
    await client.query(
      `insert into credit_notes (tenant_id, invoice_id, number, fiscal_year, amount_minor, reason,
                                 created_by, created_at)
       values ($1, $2, $3, '2025-26', $4, 'goodwill', $5, '2026-03-10T16:00:00+05:30')`,
      [tenant.id, paid, `CN-${randomUUID().slice(0, 8)}`, 1_000 * scale, by.id],
    );

    // Two verified results of one test: 30 and 60 minutes from collecting the sample.
    const test = randomUUID();
    for (const minutes of [30, 60]) {
      const sample = randomUUID();
      await client.query(
        `insert into lab_samples (id, tenant_id, order_id, encounter_id, patient_id, lab_test_id,
                                  accession_id, sample_type, collected_at, collected_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'blood', '2026-03-10T10:00:00+05:30', $8)`,
        [
          sample,
          tenant.id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          test,
          `260310-${1000 + minutes}`,
          by.id,
        ],
      );
      await client.query(
        `insert into lab_results (tenant_id, sample_id, order_id, encounter_id, patient_id,
                                  lab_test_id, test_code, test_name, result_type, value_number,
                                  status, entered_by, verified_at, verified_by)
         values ($1, $2, $3, $4, $5, $6, 'HB', 'Haemoglobin', 'numeric', 13, 'verified', $7,
                 ('2026-03-10T10:00:00+05:30'::timestamptz + make_interval(mins => $8)), $7)`,
        [tenant.id, sample, randomUUID(), randomUUID(), randomUUID(), test, by.id, minutes],
      );
    }

    // Stock: 10 + 5 of one medicine in two batches, the 5 expired, at a cost of 200 a unit.
    const drug = randomUUID();
    await client.query(
      `insert into drugs (id, tenant_id, type, generic_name, strength, form, schedule, tax_class)
       values ($1, $2, 'medicine', 'Paracetamol', '500 mg', 'tablet', 'none', 'exempt')`,
      [drug, tenant.id],
    );
    const place = randomUUID();
    await client.query(
      "insert into stock_locations (id, tenant_id, name, kind) values ($1, $2, 'Main store', 'store')",
      [place, tenant.id],
    );
    for (const [number, expiry, onHand] of [
      ['B1', '2099-01-01', 10],
      ['B2', '2020-01-01', 5],
    ] as const) {
      const batch = randomUUID();
      await client.query(
        `insert into stock_batches (id, tenant_id, drug_id, batch_number, expiry_date, cost_minor,
                                    created_by)
         values ($1, $2, $3, $4, $5, 200, $6)`,
        [batch, tenant.id, drug, number, expiry, by.id],
      );
      await client.query(
        `insert into stock_balances (tenant_id, batch_id, drug_id, location_id, on_hand)
         values ($1, $2, $3, $4, $5)`,
        [tenant.id, batch, drug, place, onHand * scale],
      );
    }
  });
}

async function removeHospitalData(tenants: TestTenant[]): Promise<void> {
  await plant(async (client) => {
    for (const table of [
      'report_runs',
      'report_settings',
      'dispense_return_lines',
      'dispense_returns',
      'dispenses',
      'pharmacy_sale_returns',
      'pharmacy_sales',
      'appointments',
      'doctors',
      'stock_balances',
      'stock_batches',
      'stock_locations',
      'drugs',
      'lab_results',
      'lab_samples',
      'credit_notes',
      'payments',
      'cash_register_sessions',
      'invoices',
      'encounters',
      'departments',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [
        tenants.map((tenant) => tenant.id),
      ]);
    }
  });
}

beforeAll(async () => {
  files = await makeTestFileStore('reports');
  store = files.store;
  app = await buildTestApp({
    resolveSession: resolveTestSession,
    jobQueue: queue,
    fileStore: store,
  });
  pool = app.database.pool;
  hospital = await createTenant(pool, 'Reports Hospital', { features: { reports: true } });
  clinic = await createTenant(pool, 'Reports Clinic', { features: { reports: true } });
  closed = await createTenant(pool, 'Reports Closed', { features: { reports: false } });
  for (const tenant of [hospital, clinic, closed]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Reports Admin');
  clinicAdmin = await createUser(pool, 'Clinic Admin');
  desk = await createUser(pool, 'Reports Desk');
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, closed, 'admin');
  await addMembership(pool, desk, hospital, 'receptionist');
  await addMembership(pool, clinicAdmin, clinic, 'admin');
  await plantHospitalData(hospital, admin, 1);
  // The clinic has the same kinds of rows, twice over, so a leak across hospitals shows as a number.
  await plantHospitalData(clinic, clinicAdmin, 2);
});

afterAll(async () => {
  await removeHospitalData([hospital, clinic, closed]);
  await deleteTenants(pool, [hospital, clinic, closed]);
  await deleteUsers(pool, [admin, clinicAdmin, desk]);
  await app.close();
  await files.cleanup();
});

describe('the reports answered on the spot', () => {
  it('counts OPD visits by day and department on the hospital clock', async () => {
    const response = await runSync('opd_census', MARCH_10);

    expect(response.statusCode).toBe(200);
    const report = response.json<ReportResult>();
    expect(report.columns.map((column) => column.key)).toEqual([
      'day',
      'department',
      'opened',
      'closed',
      'cancelled',
    ]);
    // The visit at 20:00 UTC on the 9th is 01:30 on the 10th at the hospital.
    expect(report.rows).toEqual([['2026-03-10', 'Cardiology', 3, 1, 1]]);
    expect(report.totals).toEqual([null, null, 3, 1, 1]);
    expect(report.currency).toBe('INR');
  });

  it('counts OPD visits opened by hour of the hospital’s day', async () => {
    const report = (await runSync('opd_hourly', MARCH_10)).json<ReportResult>();

    expect(report.columns.map((column) => column.key)).toEqual(['day', 'hour', 'opened']);
    // 20:00 UTC on the 9th is 01:30 on the 10th at the hospital; the 12th and the stay are left out.
    expect(report.rows).toEqual([
      ['2026-03-10', 1, 1],
      ['2026-03-10', 10, 1],
      ['2026-03-10', 11, 1],
    ]);
    expect(report.totals).toEqual([null, null, 3]);
  });

  it('counts each doctor’s OPD visits and appointments in the range', async () => {
    const report = (await runSync('doctor_activity', MARCH_10)).json<ReportResult>();

    expect(report.columns.map((column) => column.key)).toEqual([
      'doctor',
      'department',
      'opened',
      'closed',
      'cancelled',
      'appointmentsCompleted',
      'noShows',
    ]);
    // The visit and appointment on the 12th, and the inpatient stay, are not counted.
    expect(report.rows).toEqual([['Reports Admin', 'Cardiology', 3, 1, 1, 2, 1]]);
    expect(report.totals).toEqual([null, null, 3, 1, 1, 2, 1]);
  });

  it('adds up pharmacy sales, returns and dispenses by day', async () => {
    const report = (await runSync('pharmacy_sales', MARCH_10)).json<ReportResult>();

    // Sold 1,500, returned 200, net 1,300; two dispenses of 7 units less 1 brought back. Nothing from the 12th.
    expect(report.rows).toEqual([['2026-03-10', 2, 1_500, 200, 1_300, 2, 6]]);
  });

  it('adds up what was invoiced, credited, collected and refunded', async () => {
    const report = (await runSync('revenue', MARCH_10)).json<ReportResult>();

    // Issued and paid invoices count; the void one and the draft do not.
    expect(report.rows).toEqual([['2026-03-10', 15_000, 1_000, 12_000, 2_000, 10_000]]);
  });

  it('splits collections by day, method and person, and agrees with revenue', async () => {
    const report = (await runSync('collections', MARCH_10)).json<ReportResult>();
    const revenue = (await runSync('revenue', MARCH_10)).json<ReportResult>();

    expect(report.rows).toEqual([['2026-03-10', 'upi', 'Reports Admin', 12_000, 2_000, 10_000]]);
    // Net collected is the revenue report's collected less refunded for the same day.
    expect(report.totals[5]).toBe(revenue.rows[0]?.[5]);
  });

  it('shows the cash of a day as the cash register settlements of that day', async () => {
    const day = { from: '2026-03-11', to: '2026-03-11' };
    const report = (await runSync('collections', day)).json<ReportResult>();

    expect(report.rows).toEqual([['2026-03-11', 'cash', 'Reports Admin', 3_000, 0, 3_000]]);
    // The session opened with 1,000 and was expected to hold 4,000: 3,000 of cash taken.
    const { rows } = await pool.query<{ taken: string }>(
      'select (expected_minor - opening_minor)::text as taken from cash_register_sessions where tenant_id = $1',
      [hospital.id],
    );
    expect(Number(rows[0]?.taken)).toBe(report.rows[0]?.[5]);
  });

  it('groups collections by the day the register session closed', async () => {
    const range = { from: '2026-03-12', to: '2026-03-13' };
    const byRecorded = (await runSync('collections', range)).json<ReportResult>();
    const byClose = (await runSync('collections_by_close', range)).json<ReportResult>();

    // The session spans midnight: by the day recorded it is split, by its close it is one day.
    expect(byRecorded.rows).toEqual([
      ['2026-03-12', 'cash', 'Reports Admin', 700, 0, 700],
      ['2026-03-13', 'cash', 'Reports Admin', 300, 0, 300],
    ]);
    expect(byClose.rows).toEqual([['2026-03-13', 'cash', 'Reports Admin', 1_000, 0, 1_000]]);
    // Money with no session keeps the day it was recorded.
    const upi = (await runSync('collections_by_close', MARCH_10)).json<ReportResult>();
    expect(upi.rows).toEqual([['2026-03-10', 'upi', 'Reports Admin', 12_000, 2_000, 10_000]]);
  });

  it('lists issued invoices not fully paid by age, with no patient', async () => {
    const response = await runSync('outstanding', {});

    expect(response.statusCode).toBe(200);
    const report = response.json<ReportResult>();
    expect(report.from).toBeNull();
    // Planted rows leave the invoice's paid amount at 0, so all 5,000 is due, long past 30 days.
    expect(report.rows).toEqual([
      ['days_0_7', 0, 0],
      ['days_8_30', 0, 0],
      ['over_30', 1, 5_000],
    ]);
    expect(report.columns.map((c) => c.key)).toEqual(['ageBucket', 'invoices', 'dueMinor']);
  });

  it('opens a band to its invoices, paged, with numbers and amounts only', async () => {
    const drill = (tenant: TestTenant, user: TestUser, body: object) =>
      app.inject({
        method: 'POST',
        url: '/reports/outstanding/invoices',
        headers: headers(tenant, user),
        payload: body,
      });
    type Page = {
      items: { number: string; dueMinor: number; ageDays: number; patientId?: string }[];
      nextCursor: string | null;
    };

    const old = (await drill(hospital, admin, { band: 'over_30' })).json<Page>();
    expect(old.items.map((i) => i.dueMinor)).toEqual([5_000]);
    expect(old.items[0]?.ageDays).toBeGreaterThan(30);
    expect(old.items[0]).not.toHaveProperty('patientId');
    expect(old.nextCursor).toBeNull();
    expect((await drill(hospital, admin, { band: 'days_0_7' })).json<Page>().items).toEqual([]);
    // Another hospital sees only its own invoice.
    const hers = (await drill(clinic, clinicAdmin, { band: 'over_30' })).json<Page>();
    expect(hers.items.map((i) => i.dueMinor)).toEqual([10_000]);

    const ids: string[] = [];
    await plant(async (client) => {
      for (let n = 0; n < 3; n++) {
        const id = randomUUID();
        ids.push(id);
        await client.query(
          `insert into invoices (id, tenant_id, encounter_id, patient_id, number, fiscal_year, status,
                                 total_minor, currency, created_by, issued_at, issued_by)
           values ($1, $2, $3, $4, $5, '2025-26', 'issued', 700, 'INR', $6, now() - $7::interval, $6)`,
          [id, hospital.id, randomUUID(), randomUUID(), `PAGE-${n}`, admin.id, `${n} minutes`],
        );
      }
    });
    try {
      const first = (await drill(hospital, admin, { band: 'days_0_7', limit: 2 })).json<Page>();
      expect(first.items.map((i) => i.number)).toEqual(['PAGE-2', 'PAGE-1']);
      expect(first.nextCursor).not.toBeNull();
      const second = (
        await drill(hospital, admin, { band: 'days_0_7', limit: 2, cursor: first.nextCursor })
      ).json<Page>();
      expect(second.items.map((i) => i.number)).toEqual(['PAGE-0']);
      expect(second.nextCursor).toBeNull();
      expect(errorCode(await drill(hospital, admin, { band: 'days_0_7', cursor: 'nope' }))).toBe(
        'invalid_cursor',
      );
      expect((await drill(hospital, desk, { band: 'over_30' })).statusCode).toBe(403);
    } finally {
      await plant(async (client) => {
        await client.query('delete from invoices where id = any($1::uuid[])', [ids]);
      });
    }
  });

  it('measures laboratory turnaround from collection to the verified result', async () => {
    const report = (await runSync('lab_turnaround', MARCH_10)).json<ReportResult>();

    expect(report.rows).toEqual([['HB', 'Haemoglobin', 2, 45, 57, 60]]);
  });

  it('shows stock on hand, expired stock and its value, without any days', async () => {
    const response = await runSync('stock', {});

    expect(response.statusCode).toBe(200);
    const report = response.json<ReportResult>();
    expect(report.from).toBeNull();
    expect(report.rows).toEqual([['Paracetamol 500 mg', 15, 2, '2020-01-01', 5, 3_000]]);
  });

  it('never counts another hospital’s rows', async () => {
    const hers = (await runSync('opd_census', MARCH_10, clinic, clinicAdmin)).json<ReportResult>();

    expect(hers.rows).toEqual([['2026-03-10', 'Cardiology', 6, 2, 2]]);
    const hourly = (
      await runSync('opd_hourly', MARCH_10, clinic, clinicAdmin)
    ).json<ReportResult>();
    expect(hourly.rows).toEqual([
      ['2026-03-10', 1, 2],
      ['2026-03-10', 10, 2],
      ['2026-03-10', 11, 2],
    ]);
    const sales = (
      await runSync('pharmacy_sales', MARCH_10, clinic, clinicAdmin)
    ).json<ReportResult>();
    expect(sales.rows).toEqual([['2026-03-10', 2, 3_000, 400, 2_600, 2, 12]]);
    const stock = (await runSync('stock', {}, clinic, clinicAdmin)).json<ReportResult>();
    expect(stock.rows[0]?.[1]).toBe(30);
    const money = (
      await runSync('collections', MARCH_10, clinic, clinicAdmin)
    ).json<ReportResult>();
    expect(money.rows).toEqual([['2026-03-10', 'upi', 'Clinic Admin', 24_000, 4_000, 20_000]]);
    const owed = (await runSync('outstanding', {}, clinic, clinicAdmin)).json<ReportResult>();
    expect(owed.rows[2]).toEqual(['over_30', 1, 10_000]);
  });

  it('is refused for a day range that is missing, wrong or too long', async () => {
    expect(errorCode(await runSync('opd_census', {}))).toBe('range_required');
    expect(errorCode(await runSync('opd_census', { from: '2026-03-11', to: '2026-03-10' }))).toBe(
      'range_invalid',
    );
    // A day that is not on the calendar is refused by the schema before the route sees it.
    const notADay = await runSync('opd_census', { from: '2026-02-30', to: '2026-03-01' });
    expect([notADay.statusCode, errorCode(notADay)]).toEqual([400, 'validation_failed']);
    const long = await runSync('opd_census', { from: '2026-01-01', to: '2026-02-01' });
    expect([long.statusCode, errorCode(long)]).toEqual([422, 'range_too_long']);
    expect((await runSync('opd_census', { from: '2026-01-01', to: '2026-01-31' })).statusCode).toBe(
      200,
    );
  });

  it('answers a kind that does not exist with a 400', async () => {
    expect((await runSync('patients', MARCH_10)).statusCode).toBe(400);
  });

  it('is audited as a read of a report, by the person who ran it', async () => {
    await runSync('revenue', MARCH_10);

    const { rows } = await pool.query(
      "select action from audit_log where tenant_id = $1 and entity = 'report' and actor_id = $2",
      [hospital.id, admin.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual({ action: 'read' });
  });
});

describe('access', () => {
  it('needs the permission: a receptionist is refused', async () => {
    const response = await runSync('revenue', MARCH_10, hospital, desk);

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'permission_denied']);
    expect((await get('/reports/limits', hospital, desk)).statusCode).toBe(403);
  });

  it('needs the module: a hospital with it off is refused', async () => {
    const response = await runSync('revenue', MARCH_10, closed, admin);

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'feature_disabled']);
  });

  it('is closed without a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/reports/stock', payload: {} });

    expect(response.statusCode).toBe(401);
  });
});

describe('the read replica', () => {
  it('reads from the primary pool when no replica is set', () => {
    expect(app.database.reportPool).toBe(app.database.pool);
  });

  it('reads from its own pool when a replica is set, and gives the same numbers', async () => {
    const config = testConfig();
    const replicaApp = await buildTestApp({
      config: { DATABASE_REPLICA_URL: config.DATABASE_URL },
      resolveSession: resolveTestSession,
    });
    try {
      expect(replicaApp.database.reportPool).not.toBe(replicaApp.database.pool);
      const response = await replicaApp.inject({
        method: 'POST',
        url: '/reports/opd_census',
        headers: headers(hospital, admin),
        payload: MARCH_10,
      });
      expect(response.json<ReportResult>().rows).toEqual([['2026-03-10', 'Cardiology', 3, 1, 1]]);
    } finally {
      await replicaApp.close();
    }
  }, 30_000);
});

describe('stored reports', () => {
  it('are made by a job, kept with their result and a file, and downloaded by a signed link', async () => {
    const created = await createRun('revenue', MARCH_10, 'run-revenue-0001');
    expect(created.statusCode).toBe(202);
    const run = created.json<{ id: string; status: string; kind: string }>();
    expect([run.status, run.kind]).toEqual(['queued', 'revenue']);

    // The same key again adds nothing and answers with the same run.
    const again = await createRun('revenue', MARCH_10, 'run-revenue-0001');
    expect(again.statusCode).toBe(202);
    expect(again.json<{ id: string }>().id).toBe(run.id);
    expect(again.headers['idempotent-replayed']).toBe('true');

    expect((await get(`/reports/runs/${run.id}/download-url`)).statusCode).toBe(409);

    await queue.drain();
    const done = (await get(`/reports/runs/${run.id}`)).json<{
      status: string;
      rowCount: number;
      result: ReportResult;
    }>();
    expect(done.status).toBe('succeeded');
    expect(done.rowCount).toBe(1);
    expect(done.result.rows).toEqual([['2026-03-10', 15_000, 1_000, 12_000, 2_000, 10_000]]);

    const listed = (await get('/reports/runs')).json<{
      items: { id: string; result?: unknown }[];
    }>();
    expect(listed.items.map((item) => item.id)).toContain(run.id);
    expect(listed.items.every((item) => item.result === undefined)).toBe(true);

    const link = (await get(`/reports/runs/${run.id}/download-url`)).json<{ url: string }>();
    // No session at all: the signature is the credential.
    const file = await app.inject({ url: link.url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toContain(
      'report-revenue-2026-03-10-2026-03-10.csv',
    );
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.body).toBe(
      '\u{FEFF}day,invoicedMinor,creditedMinor,collectedMinor,refundedMinor,netCollectedMinor\r\n' +
        '2026-03-10,15000,1000,12000,2000,10000\r\n' +
        'total,15000,1000,12000,2000,10000\r\n',
    );

    const exported = await pool.query(
      "select 1 from audit_log where tenant_id = $1 and action = 'export' and entity_id = $2",
      [hospital.id, run.id],
    );
    expect(exported.rowCount).toBe(1);
  });

  it('refuse a forged, altered or expired link, and give one answer for all of them', async () => {
    const created = await createRun('stock', {}, 'run-stock-00001');
    await queue.drain();
    const id = created.json<{ id: string }>().id;
    const link = (await get(`/reports/runs/${id}/download-url`)).json<{ url: string }>();
    const url = new URL(link.url, 'http://x');
    const expires = Number(url.searchParams.get('expires'));
    const signature = url.searchParams.get('signature') ?? '';

    const attempts = [
      `/report-files/${id}?expires=${expires}&signature=${signature.slice(0, -2)}AA`,
      `/report-files/${id}?expires=${expires + 60}&signature=${signature}`,
      `/report-files/${randomUUID()}?expires=${expires}&signature=${signature}`,
      `/report-files/${id}?expires=${expires - 3600}&signature=${signDownload(
        app.config.REPORT_URL_SECRET,
        id,
        expires - 3600,
      )}`,
    ];
    for (const attempt of attempts) {
      const response = await app.inject({ url: attempt });
      expect([response.statusCode, errorCode(response)]).toEqual([404, 'report_file_not_found']);
    }
    expect((await app.inject({ url: link.url })).statusCode).toBe(200);
  });

  it('are another hospital’s business: its admin cannot read, list or link them', async () => {
    const created = await createRun('stock', {}, 'run-stock-00002');
    await queue.drain();
    const id = created.json<{ id: string }>().id;

    for (const url of [`/reports/runs/${id}`, `/reports/runs/${id}/download-url`]) {
      const response = await get(url, clinic, clinicAdmin);
      expect([response.statusCode, errorCode(response)]).toEqual([404, 'report_run_not_found']);
    }
    const theirs = (await get('/reports/runs', clinic, clinicAdmin)).json<{
      items: { id: string }[];
    }>();
    expect(theirs.items.map((item) => item.id)).not.toContain(id);
  });

  it('need an Idempotency-Key, the export permission and a valid range', async () => {
    const none = await app.inject({
      method: 'POST',
      url: '/reports/revenue/runs',
      headers: headers(hospital, admin),
      payload: MARCH_10,
    });
    expect(none.statusCode).toBe(400);
    expect(
      (await createRun('revenue', MARCH_10, 'run-desk-000001', hospital, desk)).statusCode,
    ).toBe(403);
    const range = await createRun(
      'revenue',
      { from: '2024-01-01', to: '2026-01-01' },
      'run-long-00001',
    );
    expect([range.statusCode, errorCode(range)]).toEqual([422, 'range_too_long']);
  });

  it('end as failed with a code when the report cannot be kept, never with the error’s text', async () => {
    const failing: FileStore = {
      put: () => Promise.reject(new Error('disk full: secret detail')),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    };
    const jobs = new MemoryQueue();
    const broken = await buildTestApp({
      resolveSession: resolveTestSession,
      jobQueue: jobs,
      fileStore: failing,
    });
    try {
      const created = await broken.inject({
        method: 'POST',
        url: '/reports/stock/runs',
        headers: { ...headers(hospital, admin), 'idempotency-key': 'run-fail-000001' },
        payload: {},
      });
      const id = created.json<{ id: string }>().id;
      await jobs.drain();

      const run = (
        await broken.inject({ url: `/reports/runs/${id}`, headers: headers(hospital, admin) })
      ).json<{ status: string; failure?: string; result?: unknown }>();
      expect(run).toMatchObject({ status: 'failed', failure: 'failed' });
      expect(run.result).toBeUndefined();
      // A failed run is no file to download.
      const link = await broken.inject({
        url: `/reports/runs/${id}/download-url`,
        headers: headers(hospital, admin),
      });
      expect(link.statusCode).toBe(409);
    } finally {
      await broken.close();
    }
  }, 30_000);
});

describe('the quota', () => {
  it('stops a hospital at its limit and leaves the others alone', async () => {
    await pool.query(
      'insert into report_settings (tenant_id, max_concurrent, max_per_day) values ($1, 1, 50)',
      [clinic.id],
    );
    const first = await createRun('stock', {}, 'quota-clinic-0001', clinic, clinicAdmin);
    expect(first.statusCode).toBe(202);

    // Not drained: the first is still waiting, so the clinic is at its one.
    const second = await createRun('stock', {}, 'quota-clinic-0002', clinic, clinicAdmin);
    expect([second.statusCode, errorCode(second)]).toEqual([429, 'report_quota']);
    expect(second.headers['retry-after']).toBe('60');

    // The hospital next door is not held up by it.
    const other = await createRun('stock', {}, 'quota-hosp-00001', hospital, admin);
    expect(other.statusCode).toBe(202);

    const limits = (await get('/reports/limits', clinic, clinicAdmin)).json<
      Record<string, number>
    >();
    expect(limits).toMatchObject({ maxConcurrent: 1, maxPerDay: 50, active: 1 });

    await queue.drain();
    expect(
      (await createRun('stock', {}, 'quota-clinic-0003', clinic, clinicAdmin)).statusCode,
    ).toBe(202);
    await queue.drain();
  });

  it('counts runs in a day, and gives the defaults to a hospital with no settings', async () => {
    await pool.query('update report_settings set max_per_day = 1 where tenant_id = $1', [
      clinic.id,
    ]);
    const refused = await createRun('stock', {}, 'quota-clinic-0004', clinic, clinicAdmin);
    expect([refused.statusCode, errorCode(refused)]).toEqual([429, 'report_quota']);
    expect(refused.headers['retry-after']).toBe('3600');

    const limits = (await get('/reports/limits')).json<Record<string, number>>();
    expect(limits).toMatchObject({ maxConcurrent: 2, maxPerDay: 50, retentionDays: 30 });
  });

  it('cannot be raised by the hospital: the app role only reads the settings', async () => {
    await expect(
      asTenantSql(pool, hospital.id, (client) =>
        client.query('update report_settings set max_per_day = 10000 where tenant_id = $1', [
          hospital.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the hourly sweep', () => {
  it('gives up a run stuck for an hour and deletes expired runs with their files', async () => {
    const stuck = randomUUID();
    const old = randomUUID();
    const key = `reports/${hospital.id}/${old}.csv`;
    await store.put(key, Buffer.from('x'));
    await plant(async (client) => {
      await client.query(
        `insert into report_runs (id, tenant_id, kind, status, requested_by, requested_at, expires_at)
         values ($1, $2, 'stock', 'running', $3, now() - interval '2 hours', now() + interval '1 day')`,
        [stuck, hospital.id, admin.id],
      );
      await client.query(
        `insert into report_runs (id, tenant_id, kind, status, requested_by, requested_at, finished_at,
                                  row_count, result, file_key, expires_at)
         values ($1, $2, 'stock', 'succeeded', $3, now() - interval '40 days', now() - interval '40 days',
                 0, '{}'::jsonb, $4, now() - interval '10 days')`,
        [old, hospital.id, admin.id, key],
      );
    });

    const failed = await sweepReports(app, store);

    expect(failed).toEqual([]);
    const { rows } = await pool.query<{ id: string; status: string; failure: string | null }>(
      'select id, status, failure from report_runs where id = any($1::uuid[])',
      [[stuck, old]],
    );
    expect(rows).toEqual([{ id: stuck, status: 'failed', failure: 'stalled' }]);
    expect(await store.get(key)).toBeNull();
  });
});

describe('row-level security', () => {
  it('hides a hospital’s runs and settings from another, in SQL as in the API', async () => {
    const mine = await createRun('stock', {}, 'rls-hospital-0001');
    expect(mine.statusCode).toBe(202);
    await queue.drain();

    await asTenantSql(pool, clinic.id, async (client) => {
      const runs = await client.query('select id from report_runs where tenant_id = $1', [
        hospital.id,
      ]);
      expect(runs.rowCount).toBe(0);
      const settings = await client.query('select 1 from report_settings where tenant_id = $1', [
        hospital.id,
      ]);
      expect(settings.rowCount).toBe(0);
    });
    await expect(
      asTenantSql(pool, clinic.id, (client) =>
        client.query(
          `insert into report_runs (tenant_id, kind, requested_by, expires_at)
           values ($1, 'stock', $2, now() + interval '1 day')`,
          [hospital.id, admin.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('jobs and limits under pressure', () => {
  const REQUEST_KINDS = { kind: 'stock' };

  /** A run row planted as the worker would find it. */
  async function plantRun(
    tenant: TestTenant,
    by: TestUser,
    columns: string,
    values: string,
  ): Promise<string> {
    const id = randomUUID();
    await plant(async (client) => {
      await client.query(
        `insert into report_runs (id, tenant_id, kind, requested_by, expires_at, ${columns})
         values ($1, $2, 'stock', $3, now() + interval '1 day', ${values})`,
        [id, tenant.id, by.id],
      );
    });
    return id;
  }
  const statusOf = async (id: string) =>
    (await pool.query<{ status: string }>('select status from report_runs where id = $1', [id]))
      .rows[0]?.status;
  const jobOf = (id: string) => ({ tenantId: hospital.id, runId: id });

  it('does nothing on a second delivery of a run that has finished', async () => {
    const created = await createRun(REQUEST_KINDS.kind, {}, 'again-0000001');
    await queue.drain();
    const id = created.json<{ id: string }>().id;
    const before = await pool.query(
      'select finished_at, started_at from report_runs where id = $1',
      [id],
    );

    await runReport(app.database, store, 10_000, jobOf(id));

    const after = await pool.query(
      'select finished_at, started_at from report_runs where id = $1',
      [id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await statusOf(id)).toBe('succeeded');
  });

  it('takes over a run whose worker stopped, never one that is still making its report', async () => {
    const silent = await plantRun(
      hospital,
      admin,
      'status, started_at',
      "'running', now() - interval '30 minutes'",
    );
    const live = await plantRun(
      hospital,
      admin,
      'status, started_at',
      "'running', now() - interval '1 minute'",
    );

    await runReport(app.database, store, 10_000, jobOf(silent));
    await runReport(app.database, store, 10_000, jobOf(live));

    expect(await statusOf(silent)).toBe('succeeded');
    expect(await statusOf(live)).toBe('running');
    await plant((client) =>
      client
        .query('delete from report_runs where id = any($1::uuid[])', [[silent, live]])
        .then(() => undefined),
    );
    await store.delete(fileKeyOf(hospital.id, silent));
  });

  it('removes the file of an expired run that never named one', async () => {
    const id = randomUUID();
    const key = fileKeyOf(hospital.id, id);
    await store.put(key, Buffer.from('left behind'));
    await plant(async (client) => {
      await client.query(
        `insert into report_runs (id, tenant_id, kind, status, failure, requested_by, finished_at,
                                  expires_at)
         values ($1, $2, 'stock', 'failed', 'failed', $3, now() - interval '31 days',
                 now() - interval '1 day')`,
        [id, hospital.id, admin.id],
      );
    });

    expect(await sweepReports(app, store)).toEqual([]);

    expect(await store.get(key)).toBeNull();
    expect(await statusOf(id)).toBeUndefined();
  });

  it('keeps a run, and tries again, when its file cannot be deleted', async () => {
    const id = randomUUID();
    await plant(async (client) => {
      await client.query(
        `insert into report_runs (id, tenant_id, kind, status, failure, requested_by, finished_at,
                                  expires_at)
         values ($1, $2, 'stock', 'failed', 'failed', $3, now() - interval '31 days',
                 now() - interval '1 day')`,
        [id, hospital.id, admin.id],
      );
    });
    const stuck: FileStore = {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.reject(new Error('locked')),
    };

    expect(await sweepReports(app, stuck)).toContain(fileKeyOf(hospital.id, id));
    expect(await statusOf(id)).toBe('failed');

    expect(await sweepReports(app, store)).not.toContain(fileKeyOf(hospital.id, id));
    expect(await statusOf(id)).toBeUndefined();
  });

  it('lets only as many through as the quota holds when requests arrive together', async () => {
    await queue.drain();

    const answers = await Promise.all(
      [1, 2, 3, 4].map((n) => createRun('stock', {}, `race-hospital-000${n}`)),
    );

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([202, 202, 429, 429]);
    await queue.drain();
  });

  it('pages the stored reports and refuses a cursor that is not ours', async () => {
    const first = (await get('/reports/runs?limit=1')).json<{
      items: { id: string }[];
      nextCursor: string | null;
    }>();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await get(`/reports/runs?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    ).json<{ items: { id: string }[] }>();
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

    const bad = await get('/reports/runs?cursor=nonsense');
    expect([bad.statusCode, errorCode(bad)]).toEqual([400, 'invalid_cursor']);
  });

  it('refuses stored reports in a hospital that has the module off', async () => {
    const response = await createRun('stock', {}, 'closed-0000001', closed, admin);

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'feature_disabled']);
    expect((await get('/reports/runs', closed, admin)).statusCode).toBe(403);
  });

  it('keeps the quota in step with the retention a hospital is given', async () => {
    await pool.query(
      'insert into report_settings (tenant_id, retention_days) values ($1, 7) on conflict do nothing',
      [hospital.id],
    );
    try {
      const id = (await createRun('stock', {}, 'retention-00001')).json<{ id: string }>().id;
      const { rows } = await pool.query<{ days: string }>(
        'select round(extract(epoch from (expires_at - requested_at)) / 86400)::text as days from report_runs where id = $1',
        [id],
      );
      expect(rows[0]?.days).toBe('7');
      await queue.drain();
    } finally {
      await pool.query('delete from report_settings where tenant_id = $1', [hospital.id]);
    }
  });
});

describe('the parts', () => {
  it('limits the reports answered at once, per hospital and for the instance', () => {
    const gate = new ReportGate(1, 2);
    const first = gate.enter('a');
    expect(first).not.toBeNull();
    expect(gate.enter('a')).toBeNull();
    const second = gate.enter('b');
    expect(second).not.toBeNull();
    expect(gate.enter('c')).toBeNull();
    first?.();
    first?.();
    expect(gate.enter('a')).not.toBeNull();
    second?.();
  });

  it('signs a link for one file and one time', () => {
    const secret = app.config.REPORT_URL_SECRET;
    const now = 1_000;
    const signature = signDownload(secret, 'run-1', 2_000);
    expect(verifyDownload(secret, 'run-1', 2_000, signature, now)).toBe(true);
    expect(verifyDownload(secret, 'run-2', 2_000, signature, now)).toBe(false);
    expect(verifyDownload(secret, 'run-1', 2_001, signature, now)).toBe(false);
    expect(verifyDownload(secret, 'run-1', 2_000, signature, 2_001)).toBe(false);
    expect(verifyDownload(secret, 'run-1', 2_000, '', now)).toBe(false);
  });

  it('keeps a spreadsheet from running a name as a formula, and quotes what needs it', () => {
    const csv = toCsv({
      kind: 'stock',
      from: null,
      to: null,
      currency: 'INR',
      generatedAt: '2026-01-01T00:00:00.000Z',
      columns: [
        { key: 'drug', type: 'text' },
        { key: 'valueMinor', type: 'money' },
      ],
      rows: [
        ['=HYPERLINK("http://x")', -5],
        ['Tab, "quoted"', 0],
        [null, 1],
      ],
      totals: [null, -4],
    }).toString('utf8');

    expect(csv).toBe(
      '\u{FEFF}drug,valueMinor\r\n' +
        '"\'=HYPERLINK(""http://x"")",-5\r\n' +
        '"Tab, ""quoted""",0\r\n' +
        ',1\r\n' +
        'total,-4\r\n',
    );
  });

  it('keeps a file’s key inside its folder', async () => {
    for (const key of ['../outside.csv', 'a/../../b', '/abs', 'UPPER.csv', 'a//b', '']) {
      await expect(store.put(key, Buffer.from('x'))).rejects.toThrow('invalid_file_key');
    }
    await store.put('reports/ok/one.csv', Buffer.from('1'));
    expect((await store.get('reports/ok/one.csv'))?.toString()).toBe('1');
    await store.delete('reports/ok/one.csv');
    await store.delete('reports/ok/one.csv');
    expect(await store.get('reports/ok/one.csv')).toBeNull();
  });
});
