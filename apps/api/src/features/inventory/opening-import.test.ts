import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * Opening stock loaded from a file through the import centre (#692): checked as an opening
 * adjustment is, written through the ledger whole or not at all, and not loaded twice.
 */

let app: FastifyInstance;
let pool: pg.Pool;
const queue = new MemoryQueue();
let hospital: TestTenant;
let clinic: TestTenant;
let admin: TestUser;
let keeper: TestUser;
const ids = { amox: '', clinicAmox: '' };

interface Batch {
  id: string;
  status: string;
  rowCount: number;
  doneCount: number;
  problemCount: number;
}
interface Problem {
  line: number;
  field?: string;
  code: string;
}
type Row = Record<string, string>;

const call = (
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  tenant = hospital,
  user = admin,
) =>
  app.inject({
    method,
    url,
    headers: as(tenant.id, user.id),
    ...(body ? { payload: body } : {}),
  });

async function staged(rows: Row[], tenant = hospital, user = admin): Promise<Batch> {
  const created = await call('POST', '/imports', { kind: 'opening_stock' }, tenant, user);
  if (created.statusCode !== 201) throw new Error(`no batch: ${created.body}`);
  const batch = created.json<Batch>();
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  for (let start = 0; start < rows.length; start += 1000) {
    const response = await call(
      'POST',
      `/imports/${batch.id}/rows`,
      {
        fields,
        rows: rows.slice(start, start + 1000).map((row, index) => ({
          line: start + index + 2,
          values: fields.map((field) => row[field] ?? ''),
        })),
      },
      tenant,
      user,
    );
    if (response.statusCode !== 200) throw new Error('rows not staged');
  }
  return batch;
}

const current = async (batch: Batch, tenant = hospital): Promise<Batch> =>
  (await call('GET', `/imports/${batch.id}`, undefined, tenant)).json<Batch>();
async function checked(batch: Batch, tenant = hospital): Promise<Batch> {
  const response = await call('POST', `/imports/${batch.id}/check`, undefined, tenant);
  if (response.statusCode !== 202) throw new Error(`no check: ${response.body}`);
  await queue.drain();
  return current(batch, tenant);
}
async function committed(batch: Batch, tenant = hospital): Promise<Batch> {
  const response = await call('POST', `/imports/${batch.id}/commit`, undefined, tenant);
  if (response.statusCode !== 202) throw new Error(`no commit: ${response.body}`);
  await queue.drain();
  return current(batch, tenant);
}

const problemsOf = async (batch: Batch) =>
  (await call('GET', `/imports/${batch.id}/problems?limit=100`)).json<{ items: Problem[] }>().items;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const line = (batchNumber: string, more: Row = {}): Row => ({
  genericName: 'Amoxicillin',
  form: 'tablet',
  strength: '500 mg',
  location: 'Main store',
  batchNumber,
  expiryDate: day(400),
  quantity: '10',
  costMinor: '1.50',
  mrpMinor: '2.25',
  ...more,
});

const onHand = async (tenant: TestTenant): Promise<number> =>
  (
    await pool.query<{ total: number }>(
      'select coalesce(sum(on_hand), 0)::int as total from stock_balances where tenant_id = $1',
      [tenant.id],
    )
  ).rows[0]?.total ?? 0;

async function addDrug(tenant: TestTenant): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into drugs (tenant_id, type, generic_name, form, strength, unit, schedule, tax_class)
     values ($1, 'medicine', 'Amoxicillin', 'tablet', '500 mg', 'piece', 'none', 'standard') returning id`,
    [tenant.id],
  );
  return rows[0]?.id ?? '';
}

beforeAll(async () => {
  app = await buildTestApp({ resolveSession: resolveTestSession, jobQueue: queue });
  pool = app.database.pool;
  const features = { imports: true, drugs: true, inventory: true };
  hospital = await createTenant(pool, 'Opening Hospital', { features });
  clinic = await createTenant(pool, 'Opening Clinic', { features });
  for (const tenant of [hospital, clinic]) await grantRoleDefaults(app, tenant);
  admin = await createUser(pool, 'Opening Admin', { withPassword: false });
  keeper = await createUser(pool, 'Opening Keeper', { withPassword: false });
  await addMembership(pool, admin, hospital, 'admin');
  await addMembership(pool, admin, clinic, 'admin');
  await addMembership(pool, keeper, hospital, 'store_keeper');
  ids.amox = await addDrug(hospital);
  ids.clinicAmox = await addDrug(clinic);
  for (const [tenant, name] of [
    [hospital, 'Main store'],
    [clinic, 'Clinic store'],
  ] as const) {
    await pool.query(
      "insert into stock_locations (tenant_id, name, kind) values ($1, $2, 'store')",
      [tenant.id, name],
    );
  }
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The ledger and the balances refuse removal to everyone: the triggers are off here.
    await client.query('set local session_replication_role = replica');
    for (const table of [
      'import_problems',
      'import_rows',
      'import_batches',
      'stock_ledger',
      'stock_balances',
      'stock_adjustments',
      'stock_batches',
      'stock_locations',
      'outbox',
      'drugs',
    ]) {
      await client.query(`delete from ${table} where tenant_id = any($1)`, [
        [hospital.id, clinic.id],
      ]);
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  await deleteUsers(pool, [admin, keeper]);
  await deleteTenants(pool, [hospital, clinic]);
  await app.close();
});

describe('opening stock import', () => {
  it('is offered to a caller with the import and the stock permissions, and to no other', async () => {
    const kinds = (await call('GET', '/imports/kinds')).json<{ items: { kind: string }[] }>();
    expect(kinds.items.map((item) => item.kind)).toContain('opening_stock');
    const asKeeper = await call('GET', '/imports/kinds', undefined, hospital, keeper);
    expect(asKeeper.statusCode).toBe(403);
  });

  it('reports a row by line and field and writes nothing', async () => {
    const before = await onHand(hospital);
    const batch = await checked(
      await staged([
        line('OK-1'),
        line('BAD-ITEM', { genericName: 'Nothing like it' }),
        line('BAD-DAY', { expiryDate: day(-1) }),
        line('BAD-PLACE', { location: 'No such store' }),
        line('BAD-OTHER', { genericName: 'Amoxicillin', location: 'Clinic store' }),
      ]),
    );
    expect(batch.problemCount).toBe(4);
    const found = (await problemsOf(batch)).map((p) => [p.line, p.field, p.code]);
    expect(found).toEqual([
      [3, 'genericName', 'unknown_item'],
      [4, 'expiryDate', 'batch_expired'],
      [5, 'location', 'unknown_location'],
      [6, 'location', 'unknown_location'],
    ]);
    const response = await call('POST', `/imports/${batch.id}/commit`);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await onHand(hospital)).toBe(before);
  });

  it('loads a large file through the ledger so the balances match it, and not twice', async () => {
    const before = await onHand(hospital);
    const rows = Array.from({ length: 600 }, (_, index) =>
      line(`BULK-${index}`, { quantity: String((index % 7) + 1) }),
    );
    const expected = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    const done = await committed(await checked(await staged(rows)));
    expect(done).toMatchObject({ status: 'committed', doneCount: 600, problemCount: 0 });
    expect(await onHand(hospital)).toBe(before + expected);
    const { rows: ledger } = await pool.query<{ count: number; reasons: string[] }>(
      `select count(*)::int as count, array_agg(distinct reason) as reasons
       from stock_ledger where tenant_id = $1 and drug_id = $2`,
      [hospital.id, ids.amox],
    );
    expect(ledger[0]?.reasons).toEqual(['opening']);
    const batchRow = await pool.query<{ cost: string; mrp: string }>(
      `select cost_minor::text as cost, mrp_minor::text as mrp from stock_batches
       where tenant_id = $1 and batch_number = 'BULK-3'`,
      [hospital.id],
    );
    expect(batchRow.rows[0]).toEqual({ cost: '150', mrp: '225' });

    const again = await checked(await staged(rows.slice(0, 5)));
    expect(again.problemCount).toBe(5);
    expect((await problemsOf(again)).every((p) => p.code === 'opening_exists')).toBe(true);
    expect(await onHand(hospital)).toBe(before + expected);
  });

  it('refuses a batch number the item has with another expiry and a repeat within the file', async () => {
    const batch = await checked(
      await staged([line('BULK-1', { expiryDate: day(500) }), line('TWICE-1'), line('TWICE-1')]),
    );
    expect((await problemsOf(batch)).map((p) => [p.line, p.code])).toEqual([
      [2, 'batch_exists'],
      [4, 'duplicate_in_file'],
    ]);
  });

  it('keeps the hospitals apart', async () => {
    const batch = await checked(
      await staged([line('CLINIC-1', { location: 'Clinic store' })], clinic),
      clinic,
    );
    expect(batch.problemCount).toBe(0);
    await committed(batch, clinic);
    const { rows } = await pool.query<{ count: number }>(
      'select count(*)::int as count from stock_ledger where tenant_id = $1 and drug_id = $2',
      [clinic.id, ids.clinicAmox],
    );
    expect(rows[0]?.count).toBe(1);
  });
});
