import type pg from 'pg';
import type { AdjustmentReason, AdjustmentStatus, LocationKind, StockAlert } from './schemas.js';

/**
 * Inventory's SQL. Every statement runs on the request's own transaction, so row-level security
 * limits it to the active hospital: no statement here names a tenant. Items are read from the
 * drug and consumable master's table for their names, as radiology reads patients; checking one
 * for an adjustment goes through `stockableDrug` from `features/drugs`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** Whether an error is the database refusing a row because of this constraint. */
export const isViolation = (error: unknown, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ['23505', '23514'].includes(String((error as { code?: unknown }).code)) &&
  (error as { constraint?: unknown }).constraint === constraint;

/**
 * Where the next page starts: the sort values of the last row, its id last. Opaque to the client;
 * null for anything that is not a cursor of this shape.
 */
const encodeCursor = (values: string[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

function decodeCursor(cursor: string, size: number): string[] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== size) return null;
    if (!value.every((each) => typeof each === 'string' && each.length <= 400)) return null;
    const strings = value as string[];
    if (strings.some((each) => each.includes('\u0000'))) return null;
    return UUID.test(strings[size - 1] ?? '') ? strings : null;
  } catch {
    return null;
  }
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only, where the list counts. */
  total?: number;
}

function paged<Row>(rows: Row[], limit: number, cursorOf: (row: Row) => string[]): Page<Row> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null,
  };
}

/** Today at the hospital, as the database's calendar date. */
const TODAY = `(select (now() at time zone timezone)::date from tenants where id = app_tenant_id())`;

// --- the item's name ---------------------------------------------------------------------------

export interface ItemColumns {
  drug_id: string;
  drug_type: 'medicine' | 'consumable';
  generic_name: string;
  brand_name: string | null;
  form: string;
  strength: string | null;
  unit: string | null;
}

const ITEM_COLUMNS = `d.id as drug_id, d.type as drug_type, d.generic_name, d.brand_name, d.form,
  d.strength, d.unit`;

// --- places ------------------------------------------------------------------------------------

export interface LocationRow {
  id: string;
  tenant_id: string;
  name: string;
  name_lower: string;
  kind: LocationKind;
  archived: boolean;
  version: number;
}

const LOCATIONS =
  'select id, tenant_id, name, name_lower, kind, archived, version from stock_locations';

/** A page of the hospital's places in use (or archived), by name. Null: a bad cursor. */
export async function listLocations(
  client: pg.ClientBase,
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
): Promise<Page<LocationRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, 2);
  if (after === null) return null;
  const { rows } = await client.query<LocationRow>(
    `${LOCATIONS}
     where archived = $1 and ($2::text is null or (name_lower, id) > ($2, $3::uuid))
     order by name_lower, id limit $4`,
    [archived, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.name_lower, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      'select count(*)::int as total from stock_locations where archived = $1',
      [archived],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findLocation(client: pg.ClientBase, id: string): Promise<LocationRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<LocationRow>(`${LOCATIONS} where id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The place, held until the transaction ends. `for update` to change it; `for share` to move
 * stock there, so it is not archived at the same moment.
 */
export async function lockLocation(
  client: pg.ClientBase,
  id: string,
  strength: 'update' | 'share' = 'update',
): Promise<LocationRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<LocationRow>(
    `${LOCATIONS} where id = $1 for ${strength === 'update' ? 'update' : 'share'}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function locationNameTaken(
  client: pg.ClientBase,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from stock_locations where name_lower = lower($1) and ($2::uuid is null or id <> $2)',
    [name, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertLocation(
  client: pg.ClientBase,
  { name, kind }: { name: string; kind: LocationKind },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'insert into stock_locations (tenant_id, name, kind) values (app_tenant_id(), $1, $2) returning id',
    [name, kind],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('location was not created');
  return id;
}

export async function updateLocation(
  client: pg.ClientBase,
  id: string,
  { name, kind, archived }: { name: string; kind: LocationKind; archived: boolean },
): Promise<void> {
  await client.query(
    'update stock_locations set name = $2, kind = $3, archived = $4 where id = $1',
    [id, name, kind, archived],
  );
}

/** Whether any batch has stock at the place. */
export async function locationHasStock(client: pg.ClientBase, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from stock_balances where location_id = $1 and on_hand > 0 limit 1',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// --- stock -------------------------------------------------------------------------------------

export interface StockItemRow extends ItemColumns {
  generic_lower: string;
  brand_lower: string;
  reorder_level: number | null;
  on_hand: number;
  hospital_on_hand: number;
}

export interface BatchBalanceRow {
  drug_id: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  mrp_minor: string | null;
  location_id: string;
  location_name: string;
  on_hand: number;
  expiry: 'ok' | 'expiring' | 'expired';
}

/**
 * What an alert asks of an item. $1 the place or null, $2 the days of "expiring". Each is a plain
 * predicate on the item `d` and its sums `s`.
 */
const ALERT: Record<StockAlert, string> = {
  low: 'd.reorder_level is not null and s.hospital_on_hand <= d.reorder_level',
  expiring: `exists (
    select 1 from stock_balances b join stock_batches t on t.tenant_id = b.tenant_id and t.id = b.batch_id
    where b.tenant_id = d.tenant_id and b.drug_id = d.id and b.on_hand > 0
      and ($1::uuid is null or b.location_id = $1)
      and t.expiry_date >= ${TODAY} and t.expiry_date <= ${TODAY} + $2::int)`,
  expired: `exists (
    select 1 from stock_balances b join stock_batches t on t.tenant_id = b.tenant_id and t.id = b.batch_id
    where b.tenant_id = d.tenant_id and b.drug_id = d.id and b.on_hand > 0
      and ($1::uuid is null or b.location_id = $1)
      and t.expiry_date < ${TODAY})`,
};

// The items in use with their stock: at the place ($1, or everywhere) and at the hospital. It
// names $2, the days of "expiring", so the statement has its type whatever the alert.
const ITEMS_WITH_SUMS = `
  from drugs d
  cross join lateral (
    select coalesce(sum(b.on_hand), 0)::int as hospital_on_hand,
      coalesce(sum(b.on_hand) filter (where $1::uuid is null or b.location_id = $1), 0)::int as on_hand
    from stock_balances b where b.tenant_id = d.tenant_id and b.drug_id = d.id
  ) s
  where not d.archived and $2::int > 0`;

/**
 * A page of the hospital's items in use with their stock, by generic name then brand, every item
 * or those an alert names. Null: a bad cursor. Counted on the first page.
 */
export async function listStock(
  client: pg.ClientBase,
  options: {
    locationId: string | null;
    drugId: string | null;
    alert: StockAlert | null;
    expiringWithinDays: number;
    cursor?: string;
    limit: number;
  },
): Promise<Page<StockItemRow> | null> {
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor, 3);
  if (after === null) return null;
  const filters = `
    and ($3::uuid is null or d.id = $3)
    ${options.alert ? `and ${ALERT[options.alert]}` : ''}`;
  const { rows } = await client.query<StockItemRow>(
    `select ${ITEM_COLUMNS}, d.generic_lower, d.brand_lower, d.reorder_level,
       s.on_hand, s.hospital_on_hand
     ${ITEMS_WITH_SUMS} ${filters}
       and ($4::text is null or (d.generic_lower, d.brand_lower, d.id) > ($4, $5, $6::uuid))
     order by d.generic_lower, d.brand_lower, d.id
     limit $7`,
    [
      options.locationId,
      options.expiringWithinDays,
      options.drugId,
      after?.[0] ?? null,
      after?.[1] ?? null,
      after?.[2] ?? null,
      options.limit + 1,
    ],
  );
  const result = paged(rows, options.limit, (row) => [
    row.generic_lower,
    row.brand_lower,
    row.drug_id,
  ]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total ${ITEMS_WITH_SUMS} ${filters}`,
      [options.locationId, options.expiringWithinDays, options.drugId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** How many items each alert names. */
export async function alertCounts(
  client: pg.ClientBase,
  { locationId, expiringWithinDays }: { locationId: string | null; expiringWithinDays: number },
): Promise<Record<StockAlert, number>> {
  const { rows } = await client.query<Record<StockAlert, number>>(
    `select count(*) filter (where ${ALERT.low})::int as low,
       count(*) filter (where ${ALERT.expiring})::int as expiring,
       count(*) filter (where ${ALERT.expired})::int as expired
     ${ITEMS_WITH_SUMS}`,
    [locationId, expiringWithinDays],
  );
  return rows[0] ?? { low: 0, expiring: 0, expired: 0 };
}

/** The batches with stock of these items, at the place or everywhere, soonest expiry first. */
export async function batchBalances(
  client: pg.ClientBase,
  {
    drugIds,
    locationId,
    expiringWithinDays,
  }: {
    drugIds: string[];
    locationId: string | null;
    expiringWithinDays: number;
  },
): Promise<BatchBalanceRow[]> {
  if (drugIds.length === 0) return [];
  const { rows } = await client.query<BatchBalanceRow>(
    `select b.drug_id, b.batch_id, t.batch_number, to_char(t.expiry_date, 'YYYY-MM-DD') as expiry_date,
       t.mrp_minor, b.location_id, l.name as location_name, b.on_hand,
       case when t.expiry_date < ${TODAY} then 'expired'
            when t.expiry_date <= ${TODAY} + $3::int then 'expiring'
            else 'ok' end as expiry
     from stock_balances b
     join stock_batches t on t.tenant_id = b.tenant_id and t.id = b.batch_id
     join stock_locations l on l.tenant_id = b.tenant_id and l.id = b.location_id
     where b.drug_id = any($1::uuid[]) and b.on_hand > 0 and ($2::uuid is null or b.location_id = $2)
     order by t.expiry_date, t.batch_key, l.name_lower, b.location_id`,
    [drugIds, locationId, expiringWithinDays],
  );
  return rows;
}

/** An item's stock at the whole hospital. */
export async function hospitalOnHand(client: pg.ClientBase, drugId: string): Promise<number> {
  const { rows } = await client.query<{ total: number }>(
    'select coalesce(sum(on_hand), 0)::int as total from stock_balances where drug_id = $1',
    [drugId],
  );
  return rows[0]?.total ?? 0;
}

/** A batch's stock at a place: 0 when it has never been there. */
export async function onHandAt(
  client: pg.ClientBase,
  batchId: string,
  locationId: string,
): Promise<number> {
  const { rows } = await client.query<{ on_hand: number }>(
    'select on_hand from stock_balances where batch_id = $1 and location_id = $2',
    [batchId, locationId],
  );
  return rows[0]?.on_hand ?? 0;
}

// --- batches -----------------------------------------------------------------------------------

export interface BatchRow {
  id: string;
  drug_id: string;
  batch_number: string;
  expiry_date: string;
}

const BATCHES = `select id, drug_id, batch_number, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date
  from stock_batches`;

export async function findBatch(client: pg.ClientBase, id: string): Promise<BatchRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<BatchRow>(`${BATCHES} where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The item's batch of this number, whatever the capitals. */
export async function batchByNumber(
  client: pg.ClientBase,
  drugId: string,
  batchNumber: string,
): Promise<BatchRow | null> {
  const { rows } = await client.query<BatchRow>(
    `${BATCHES} where drug_id = $1 and batch_key = upper($2)`,
    [drugId, batchNumber],
  );
  return rows[0] ?? null;
}

/**
 * Makes the batch, or finds the one of that number made at the same moment by someone else.
 */
export async function insertBatch(
  client: pg.ClientBase,
  batch: {
    drugId: string;
    batchNumber: string;
    expiryDate: string;
    mrpMinor: string | null;
    costMinor: string | null;
    createdBy: string;
  },
): Promise<BatchRow> {
  await client.query(
    `insert into stock_batches (tenant_id, drug_id, batch_number, expiry_date, mrp_minor, cost_minor, created_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     on conflict on constraint stock_batches_number_taken do nothing`,
    [
      batch.drugId,
      batch.batchNumber,
      batch.expiryDate,
      batch.mrpMinor,
      batch.costMinor,
      batch.createdBy,
    ],
  );
  const row = await batchByNumber(client, batch.drugId, batch.batchNumber);
  if (!row) throw new Error('batch was not created');
  return row;
}

// --- the ledger --------------------------------------------------------------------------------

/**
 * Posts a change of stock: its trigger moves the balance, which a negative result refuses
 * (`stock_balances_not_negative`). Returns the balance after it.
 */
export async function postEntry(
  client: pg.ClientBase,
  entry: {
    batchId: string;
    drugId: string;
    locationId: string;
    quantity: number;
    source: 'adjustment';
    sourceId: string;
    reason: AdjustmentReason;
    actorId: string;
  },
): Promise<{ id: string; balanceAfter: number }> {
  const { rows } = await client.query<{ id: string; balance_after: number }>(
    `insert into stock_ledger (tenant_id, batch_id, drug_id, location_id, quantity, source, source_id, reason, actor_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     returning id, balance_after`,
    [
      entry.batchId,
      entry.drugId,
      entry.locationId,
      entry.quantity,
      entry.source,
      entry.sourceId,
      entry.reason,
      entry.actorId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('entry was not posted');
  return { id: row.id, balanceAfter: row.balance_after };
}

export interface LedgerRow extends ItemColumns {
  id: string;
  at: Date;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  location_id: string;
  location_name: string;
  quantity: number;
  balance_after: number;
  source: 'adjustment';
  source_id: string;
  reason: AdjustmentReason;
  actor_name: string | null;
  /** The instant to the microsecond, for the cursor: a Date keeps milliseconds only. */
  at_exact: string;
}

/** A page of the ledger, newest first, of an item, a batch, a place and a time. Null: bad cursor. */
export async function listLedger(
  client: pg.ClientBase,
  options: {
    drugId: string | null;
    batchId: string | null;
    locationId: string | null;
    from: string | null;
    to: string | null;
    cursor?: string;
    limit: number;
  },
): Promise<Page<LedgerRow> | null> {
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor, 2);
  if (after === null) return null;
  const { rows } = await client.query<LedgerRow>(
    `select e.id, e.at, ${ITEM_COLUMNS}, e.batch_id, t.batch_number,
       to_char(t.expiry_date, 'YYYY-MM-DD') as expiry_date, e.location_id, l.name as location_name,
       e.quantity, e.balance_after, e.source, e.source_id, e.reason, u.name as actor_name,
       to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_exact
     from stock_ledger e
     join drugs d on d.tenant_id = e.tenant_id and d.id = e.drug_id
     join stock_batches t on t.tenant_id = e.tenant_id and t.id = e.batch_id
     join stock_locations l on l.tenant_id = e.tenant_id and l.id = e.location_id
     left join users u on u.id = e.actor_id
     where ($1::uuid is null or e.drug_id = $1)
       and ($2::uuid is null or e.batch_id = $2)
       and ($3::uuid is null or e.location_id = $3)
       and ($4::timestamptz is null or e.at >= $4)
       and ($5::timestamptz is null or e.at < $5)
       and ($6::timestamptz is null or (e.at, e.id) < ($6, $7::uuid))
     order by e.at desc, e.id desc
     limit $8`,
    [
      options.drugId,
      options.batchId,
      options.locationId,
      options.from,
      options.to,
      after?.[0] ?? null,
      after?.[1] ?? null,
      options.limit + 1,
    ],
  );
  return paged(rows, options.limit, (row) => [row.at_exact, row.id]);
}

// --- adjustments -------------------------------------------------------------------------------

export interface AdjustmentRow extends ItemColumns {
  id: string;
  tenant_id: string;
  location_id: string;
  location_name: string;
  batch_id: string | null;
  batch_number: string;
  expiry_date: string;
  new_batch: boolean;
  mrp_minor: string | null;
  cost_minor: string | null;
  quantity: number;
  reason: AdjustmentReason;
  note: string | null;
  on_hand: number;
  status: AdjustmentStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: Date;
  /** The instant to the microsecond, for the cursor: a Date keeps milliseconds only. */
  requested_at_exact: string;
  decided_by_name: string | null;
  decided_at: Date | null;
  rejection_note: string | null;
  version: number;
}

const ADJUSTMENTS = `
  select a.id, a.tenant_id, a.location_id, l.name as location_name, ${ITEM_COLUMNS},
    a.batch_id, coalesce(t.batch_number, a.batch_number) as batch_number,
    to_char(coalesce(t.expiry_date, a.expiry_date), 'YYYY-MM-DD') as expiry_date,
    a.batch_number is not null as new_batch,
    coalesce(a.mrp_minor, t.mrp_minor) as mrp_minor, coalesce(a.cost_minor, t.cost_minor) as cost_minor,
    a.quantity, a.reason, a.note,
    coalesce((select b.on_hand from stock_balances b
              where b.tenant_id = a.tenant_id and b.batch_id = a.batch_id and b.location_id = a.location_id), 0)
      as on_hand,
    a.status, a.requested_by, ru.name as requested_by_name, a.requested_at,
    to_char(a.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_at_exact,
    du.name as decided_by_name, a.decided_at, a.rejection_note, a.version
  from stock_adjustments a
  join stock_locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
  join drugs d on d.tenant_id = a.tenant_id and d.id = a.drug_id
  left join stock_batches t on t.tenant_id = a.tenant_id and t.id = a.batch_id
  left join users ru on ru.id = a.requested_by
  left join users du on du.id = a.decided_by`;

/** A page of the adjustments of a status, newest asked first. Null: a bad cursor. */
export async function listAdjustments(
  client: pg.ClientBase,
  { status, cursor, limit }: { status: AdjustmentStatus; cursor?: string; limit: number },
): Promise<Page<AdjustmentRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, 2);
  if (after === null) return null;
  const { rows } = await client.query<AdjustmentRow>(
    `${ADJUSTMENTS}
     where a.status = $1 and ($2::timestamptz is null or (a.requested_at, a.id) < ($2, $3::uuid))
     order by a.requested_at desc, a.id desc
     limit $4`,
    [status, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.requested_at_exact, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      'select count(*)::int as total from stock_adjustments where status = $1',
      [status],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findAdjustment(
  client: pg.ClientBase,
  id: string,
): Promise<AdjustmentRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<AdjustmentRow>(`${ADJUSTMENTS} where a.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The adjustment, held until the transaction ends, so it is decided once. */
export async function lockAdjustment(
  client: pg.ClientBase,
  id: string,
): Promise<AdjustmentRow | null> {
  if (!UUID.test(id)) return null;
  const locked = await client.query('select 1 from stock_adjustments where id = $1 for update', [
    id,
  ]);
  return locked.rowCount === 1 ? findAdjustment(client, id) : null;
}

export async function insertAdjustment(
  client: pg.ClientBase,
  adjustment: {
    locationId: string;
    drugId: string;
    batchId: string | null;
    batchNumber: string | null;
    expiryDate: string | null;
    mrpMinor: number | null;
    costMinor: number | null;
    quantity: number;
    reason: AdjustmentReason;
    note: string | null;
    requestedBy: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into stock_adjustments (tenant_id, location_id, drug_id, batch_id, batch_number, expiry_date,
       mrp_minor, cost_minor, quantity, reason, note, requested_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      adjustment.locationId,
      adjustment.drugId,
      adjustment.batchId,
      adjustment.batchNumber,
      adjustment.expiryDate,
      adjustment.mrpMinor,
      adjustment.costMinor,
      adjustment.quantity,
      adjustment.reason,
      adjustment.note,
      adjustment.requestedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('adjustment was not created');
  return id;
}

export async function decideAdjustment(
  client: pg.ClientBase,
  id: string,
  decision: {
    status: 'approved' | 'rejected';
    decidedBy: string;
    batchId: string | null;
    rejectionNote: string | null;
  },
): Promise<void> {
  await client.query(
    `update stock_adjustments
     set status = $2, decided_by = $3, decided_at = now(), batch_id = coalesce(batch_id, $4),
       rejection_note = $5
     where id = $1`,
    [id, decision.status, decision.decidedBy, decision.batchId, decision.rejectionNote],
  );
}
