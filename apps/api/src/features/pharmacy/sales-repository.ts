import type pg from 'pg';
import { isUuid, type Page } from './repository.js';

/**
 * The SQL of counter sales, their returns and the drug register (#101). Every statement runs on
 * the request's own transaction, so row-level security limits it to the active hospital. Stock
 * moves only through inventory's `stockOut` and `stockIn`; the register reads the ledger.
 */

/** An instant as the cursors hold it: UTC, to the microsecond. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const EXACT = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const encodeCursor = (values: string[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

/** A cursor `[kind, instant, id]` of this kind, or null for anything else. */
function decodeCursor(cursor: string, kind: string): [string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [named, at, id] = value as unknown[];
    if (named !== kind || typeof at !== 'string' || typeof id !== 'string') return null;
    if (!INSTANT.test(at) || Number.isNaN(Date.parse(at)) || !isUuid(id)) return null;
    return [at, id];
  } catch {
    return null;
  }
}

/** Today at the hospital, `YYYY-MM-DD`. */
export async function todayAtHospital(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today
     from tenants where id = app_tenant_id()`,
  );
  return rows[0]?.today ?? '';
}

/** Holds the sale against another return of it until the transaction ends. */
export async function lockSale(client: pg.ClientBase, saleId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended('pharmacy_sale:' || $1, 0))`, [
    saleId,
  ]);
}

export async function insertSale(
  client: pg.ClientBase,
  sale: {
    id: string;
    locationId: string;
    patientId: string | null;
    prescriberName: string | null;
    prescriberRegistration: string | null;
    prescribedOn: string | null;
    totalMinor: bigint;
    soldBy: string;
  },
): Promise<void> {
  await client.query(
    `insert into pharmacy_sales (id, tenant_id, location_id, patient_id, prescriber_name,
       prescriber_registration, prescribed_on, total_minor, sold_by)
     values ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8)`,
    [
      sale.id,
      sale.locationId,
      sale.patientId,
      sale.prescriberName,
      sale.prescriberRegistration,
      sale.prescribedOn,
      sale.totalMinor.toString(),
      sale.soldBy,
    ],
  );
}

export async function insertSaleLine(
  client: pg.ClientBase,
  line: {
    saleId: string;
    lineNumber: number;
    drugId: string;
    itemName: string;
    schedule: string;
    controlled: boolean;
    batchId: string;
    quantity: number;
    unitPriceMinor: bigint;
    ledgerEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into pharmacy_sale_lines (tenant_id, sale_id, line_number, drug_id, item_name,
       schedule, controlled, batch_id, quantity, unit_price_minor, ledger_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      line.saleId,
      line.lineNumber,
      line.drugId,
      line.itemName,
      line.schedule,
      line.controlled,
      line.batchId,
      line.quantity,
      line.unitPriceMinor.toString(),
      line.ledgerEntryId,
    ],
  );
}

export async function insertSaleReturn(
  client: pg.ClientBase,
  saleReturn: {
    id: string;
    saleId: string;
    reason: string;
    totalMinor: bigint;
    returnedBy: string;
  },
): Promise<void> {
  await client.query(
    `insert into pharmacy_sale_returns (id, tenant_id, sale_id, reason, total_minor, returned_by)
     values ($1, app_tenant_id(), $2, $3, $4, $5)`,
    [
      saleReturn.id,
      saleReturn.saleId,
      saleReturn.reason,
      saleReturn.totalMinor.toString(),
      saleReturn.returnedBy,
    ],
  );
}

export async function insertSaleReturnLine(
  client: pg.ClientBase,
  line: {
    returnId: string;
    saleId: string;
    saleLineId: string;
    batchId: string;
    quantity: number;
    ledgerEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into pharmacy_sale_return_lines (tenant_id, return_id, sale_id, sale_line_id, batch_id,
       quantity, ledger_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
    [line.returnId, line.saleId, line.saleLineId, line.batchId, line.quantity, line.ledgerEntryId],
  );
}

export interface SaleRow {
  id: string;
  location_id: string;
  location_name: string;
  patient_id: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  prescriber_name: string | null;
  prescriber_registration: string | null;
  prescribed_on: string | null;
  total_minor: string;
  returned_minor: string;
  sold_at: Date;
  sold_by_name: string;
  lines: {
    id: string;
    lineNumber: number;
    drugId: string;
    itemName: string;
    schedule: string;
    controlled: boolean;
    batchId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    returnedQuantity: number;
    unitPriceMinor: string;
  }[];
  returns: {
    id: string;
    reason: string;
    totalMinor: string;
    returnedAt: string;
    returnedByName: string;
    lines: { saleLineId: string; quantity: number }[];
  }[];
}

const RETURNED = (sale: string) => `coalesce((select sum(r.total_minor) from pharmacy_sale_returns r
    where r.tenant_id = ${sale}.tenant_id and r.sale_id = ${sale}.id), 0)::text`;

export async function findSale(client: pg.ClientBase, id: string): Promise<SaleRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<SaleRow>(
    `select s.id, s.location_id, l.name as location_name, s.patient_id,
       pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
       s.prescriber_name, s.prescriber_registration,
       to_char(s.prescribed_on, 'YYYY-MM-DD') as prescribed_on,
       s.total_minor::text as total_minor, ${RETURNED('s')} as returned_minor,
       s.sold_at, coalesce(u.name, '') as sold_by_name,
       coalesce((
         select json_agg(json_build_object(
             'id', sl.id, 'lineNumber', sl.line_number, 'drugId', sl.drug_id,
             'itemName', sl.item_name, 'schedule', sl.schedule, 'controlled', sl.controlled,
             'batchId', sl.batch_id, 'batchNumber', b.batch_number,
             'expiryDate', to_char(b.expiry_date, 'YYYY-MM-DD'), 'quantity', sl.quantity,
             'returnedQuantity', coalesce((select sum(rl.quantity) from pharmacy_sale_return_lines rl
               where rl.tenant_id = sl.tenant_id and rl.sale_line_id = sl.id), 0),
             'unitPriceMinor', sl.unit_price_minor::text)
           order by sl.line_number)
         from pharmacy_sale_lines sl
         join stock_batches b on b.tenant_id = sl.tenant_id and b.id = sl.batch_id
         where sl.tenant_id = s.tenant_id and sl.sale_id = s.id
       ), '[]'::json) as lines,
       coalesce((
         select json_agg(json_build_object(
             'id', r.id, 'reason', r.reason, 'totalMinor', r.total_minor::text,
             'returnedAt', ${EXACT('r.returned_at')}, 'returnedByName', coalesce(ru.name, ''),
             'lines', (select coalesce(json_agg(json_build_object(
                   'saleLineId', rl.sale_line_id, 'quantity', rl.quantity) order by rl.id), '[]'::json)
                 from pharmacy_sale_return_lines rl
                 where rl.tenant_id = r.tenant_id and rl.return_id = r.id))
           order by r.returned_at, r.id)
         from pharmacy_sale_returns r
         left join users ru on ru.id = r.returned_by
         where r.tenant_id = s.tenant_id and r.sale_id = s.id
       ), '[]'::json) as returns
     from pharmacy_sales s
     join stock_locations l on l.tenant_id = s.tenant_id and l.id = s.location_id
     left join patients pt on pt.tenant_id = s.tenant_id and pt.id = s.patient_id
     left join users u on u.id = s.sold_by
     where s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** The return just written, or one found again by its id on a repeat: its sale. */
export async function saleOfReturn(
  client: pg.ClientBase,
  returnId: string,
): Promise<string | null> {
  if (!isUuid(returnId)) return null;
  const { rows } = await client.query<{ sale_id: string }>(
    'select sale_id from pharmacy_sale_returns where id = $1',
    [returnId],
  );
  return rows[0]?.sale_id ?? null;
}

export interface SaleListRow {
  id: string;
  sold_at: Date;
  sold_by_name: string;
  location_name: string;
  patient_id: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  line_count: number;
  total_minor: string;
  returned_minor: string;
  at_exact: string;
  total: number;
}

/** Midnight at the hospital `days - 1` days ago. */
const WINDOW_START = `(select (((now() at time zone timezone)::date - ($1::int - 1))::timestamp
  at time zone timezone) from tenants where id = app_tenant_id())`;

/** A page of the hospital's sales within the days asked, the newest first. Null: a bad cursor. */
export async function listSales(
  client: pg.ClientBase,
  options: { days: number; cursor?: string; limit: number },
): Promise<Page<SaleListRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'sales') : undefined;
  if (after === null) return null;
  const { rows } = await client.query<SaleListRow>(
    `select s.id, s.sold_at, coalesce(u.name, '') as sold_by_name, l.name as location_name,
       s.patient_id, pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
       (select count(*) from pharmacy_sale_lines sl
         where sl.tenant_id = s.tenant_id and sl.sale_id = s.id)::int as line_count,
       s.total_minor::text as total_minor, ${RETURNED('s')} as returned_minor,
       ${EXACT('s.sold_at')} as at_exact,
       count(*) over ()::int as total
     from pharmacy_sales s
     join stock_locations l on l.tenant_id = s.tenant_id and l.id = s.location_id
     left join patients pt on pt.tenant_id = s.tenant_id and pt.id = s.patient_id
     left join users u on u.id = s.sold_by
     where s.sold_at >= ${WINDOW_START}
       and ($2::timestamptz is null or (s.sold_at, s.id) < ($2::timestamptz, $3::uuid))
     order by s.sold_at desc, s.id desc
     limit $4`,
    [options.days, after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last ? encodeCursor(['sales', last.at_exact, last.id]) : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export interface RegisterRow {
  id: string;
  at: Date;
  location_name: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  balance_after: number;
  source: string;
  source_id: string;
  reason: string;
  actor_name: string;
  patient_id: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  prescription_id: string | null;
  prescriber_name: string | null;
  prescriber_registration: string | null;
  /** The sale a sale's or a return's entry belongs to. */
  sale_id: string | null;
  /** The dispense a dispense's or its return's entry belongs to. */
  dispense_id: string | null;
  at_exact: string;
  total: number;
}

/** Midnight at the hospital at the start of a calendar date given as `$n`, `days` after it. */
const DAY_START = (param: string, days = 0) => `(select (($${param}::date + ${days})::timestamp
  at time zone timezone) from tenants where id = app_tenant_id())`;

/**
 * A page of an item's movements from the ledger, from the first day to the last at the hospital,
 * the oldest first, with who each dispense or sale was for and who prescribed it. Null: a bad
 * cursor.
 */
export async function listRegister(
  client: pg.ClientBase,
  options: { drugId: string; from: string; to: string; cursor?: string; limit: number },
): Promise<Page<RegisterRow> | null> {
  const after = options.cursor
    ? decodeCursor(options.cursor, `register:${options.drugId}`)
    : undefined;
  if (after === null) return null;
  const { rows } = await client.query<RegisterRow>(
    `select e.id, e.at, l.name as location_name, b.batch_number,
       to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date, e.quantity, e.balance_after,
       e.source, e.source_id, e.reason, coalesce(u.name, '') as actor_name,
       pt.id as patient_id, pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
       d.prescription_id,
       coalesce(pu.name, s.prescriber_name) as prescriber_name, s.prescriber_registration,
       s.id as sale_id, d.id as dispense_id,
       ${EXACT('e.at')} as at_exact,
       count(*) over ()::int as total
     from stock_ledger e
     join stock_batches b on b.tenant_id = e.tenant_id and b.id = e.batch_id
     join stock_locations l on l.tenant_id = e.tenant_id and l.id = e.location_id
     left join users u on u.id = e.actor_id
     left join dispense_returns dr
       on e.source = 'dispense_return' and dr.tenant_id = e.tenant_id and dr.id = e.source_id
     left join dispenses d on d.tenant_id = e.tenant_id
       and d.id = case e.source when 'dispense' then e.source_id when 'dispense_return' then dr.dispense_id end
     left join prescriptions rx on rx.tenant_id = d.tenant_id and rx.id = d.prescription_id
     left join users pu on pu.id = rx.prescribed_by
     left join pharmacy_sale_returns r
       on e.source = 'sale_return' and r.tenant_id = e.tenant_id and r.id = e.source_id
     left join pharmacy_sales s on s.tenant_id = e.tenant_id
       and s.id = case e.source when 'sale' then e.source_id when 'sale_return' then r.sale_id end
     left join patients pt on pt.tenant_id = e.tenant_id and pt.id = coalesce(d.patient_id, s.patient_id)
     where e.drug_id = $1
       and e.at >= ${DAY_START('2')} and e.at < ${DAY_START('3', 1)}
       and ($4::timestamptz is null or (e.at, e.id) > ($4::timestamptz, $5::uuid))
     order by e.at, e.id
     limit $6`,
    [
      options.drugId,
      options.from,
      options.to,
      after?.[0] ?? null,
      after?.[1] ?? null,
      options.limit + 1,
    ],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor([`register:${options.drugId}`, last.at_exact, last.id])
        : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}
