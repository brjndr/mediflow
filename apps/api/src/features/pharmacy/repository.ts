import type pg from 'pg';
import type { QueueState } from './schemas.js';

/**
 * The pharmacy's SQL. Every statement runs on the request's own transaction, so row-level security
 * limits it to the active hospital: no statement here names a tenant. The queue and a
 * prescription read the prescriptions, their medication orders, patients and staff names in SQL,
 * as radiology reads its worklist; orders are only ever changed through `moveMedicationOrder` and
 * stock only through `stockOut`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** An instant as the cursors hold it: UTC, to the microsecond. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const EXACT = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const encodeCursor = (values: string[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

/** The queue's cursor, `[state, instant, id]`, or null for anything else. */
function decodeCursor(cursor: string, state: QueueState): [string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [kind, at, id] = value as unknown[];
    if (kind !== state || typeof at !== 'string' || typeof id !== 'string') return null;
    if (!INSTANT.test(at) || Number.isNaN(Date.parse(at)) || !UUID.test(id)) return null;
    return [at, id];
  } catch {
    return null;
  }
}

/** Midnight at the hospital `days - 1` days ago: the start of the queue's window. */
const WINDOW_START = `(select (((now() at time zone timezone)::date - ($1::int - 1))::timestamp
  at time zone timezone) from tenants where id = app_tenant_id())`;

export interface QueueRow {
  prescription_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  prescribed_at: Date;
  prescribed_by_name: string;
  line_count: number;
  open_count: number;
  started_count: number;
  at_exact: string;
  total: number;
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  total?: number;
}

/**
 * A page of the queue: `open`, the prescriptions with a medication line still to dispense, the
 * oldest first; `done`, those with none left and some dispensed, the newest first. Within the
 * window of days, of one patient when asked. Null: a bad cursor.
 */
export async function listQueue(
  client: pg.ClientBase,
  options: {
    state: QueueState;
    days: number;
    patientId: string | null;
    cursor?: string;
    limit: number;
  },
): Promise<Page<QueueRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, options.state) : undefined;
  if (after === null) return null;
  const open = options.state === 'open';
  const { rows } = await client.query<QueueRow>(
    `select rx.id as prescription_id, rx.encounter_id, rx.patient_id,
       pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
       rx.prescribed_at, coalesce(u.name, '') as prescribed_by_name,
       l.line_count, l.open_count, l.started_count,
       ${EXACT('rx.prescribed_at')} as at_exact,
       count(*) over ()::int as total
     from prescriptions rx
     cross join lateral (
       select count(*)::int as line_count,
         count(*) filter (where o.status in ('placed', 'accepted', 'in_progress'))::int as open_count,
         count(*) filter (where o.status in ('in_progress', 'completed'))::int as started_count
       from orders o
       where o.tenant_id = rx.tenant_id and o.prescription_id = rx.id and o.type = 'medication'
     ) l
     join patients pt on pt.tenant_id = rx.tenant_id and pt.id = rx.patient_id
     left join users u on u.id = rx.prescribed_by
     where rx.prescribed_at >= ${WINDOW_START}
       and ($2::uuid is null or rx.patient_id = $2)
       and ${open ? 'l.open_count > 0' : 'l.open_count = 0 and l.started_count > 0'}
       and ($3::timestamptz is null or (rx.prescribed_at, rx.id) ${open ? '>' : '<'} ($3::timestamptz, $4::uuid))
     order by rx.prescribed_at ${open ? 'asc' : 'desc'}, rx.id ${open ? 'asc' : 'desc'}
     limit $5`,
    [options.days, options.patientId, after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor([options.state, last.at_exact, last.prescription_id])
        : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export interface PrescriptionRow {
  id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  prescribed_at: Date;
  prescribed_by_name: string;
  advice: string | null;
  replaces_id: string | null;
  replaced_by_id: string | null;
}

/** A prescription with a medication line, with who it is for and who wrote it. */
export async function findPrescription(
  client: pg.ClientBase,
  id: string,
): Promise<PrescriptionRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<PrescriptionRow>(
    `select rx.id, rx.encounter_id, rx.patient_id,
       pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
       rx.prescribed_at, coalesce(u.name, '') as prescribed_by_name, rx.advice, rx.replaces_id,
       (select r.id from prescriptions r where r.tenant_id = rx.tenant_id and r.replaces_id = rx.id)
         as replaced_by_id
     from prescriptions rx
     join patients pt on pt.tenant_id = rx.tenant_id and pt.id = rx.patient_id
     left join users u on u.id = rx.prescribed_by
     where rx.id = $1
       and exists (select 1 from orders o where o.prescription_id = rx.id and o.type = 'medication')`,
    [id],
  );
  return rows[0] ?? null;
}

export interface LineRow {
  order_id: string;
  line_number: number;
  version: number;
  status: 'placed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  drug_id: string;
  item_name: string;
  dose: string;
  frequency: string;
  route: string;
  duration_days: number | null;
  quantity: number | null;
  instructions: string | null;
  cancel_reason: string | null;
  dispensed_quantity: number;
}

/** A prescription's medication lines in their order, with the units dispensed against each. */
export async function linesOf(client: pg.ClientBase, prescriptionId: string): Promise<LineRow[]> {
  const { rows } = await client.query<LineRow>(
    `select o.id as order_id, o.line_number, o.version, o.status, o.drug_id, o.item_name, o.dose,
       o.frequency, o.route, o.duration_days, o.quantity, o.instructions, o.cancel_reason,
       coalesce((select sum(d.quantity) from dispenses d
                 where d.tenant_id = o.tenant_id and d.order_id = o.id), 0)::int as dispensed_quantity
     from orders o
     where o.prescription_id = $1 and o.type = 'medication'
     order by o.line_number`,
    [prescriptionId],
  );
  return rows;
}

/** The units dispensed against an order so far. */
export async function dispensedOf(client: pg.ClientBase, orderId: string): Promise<number> {
  const { rows } = await client.query<{ total: number }>(
    'select coalesce(sum(quantity), 0)::int as total from dispenses where order_id = $1',
    [orderId],
  );
  return rows[0]?.total ?? 0;
}

export interface DispenseRow {
  id: string;
  order_id: string;
  prescription_id: string;
  encounter_id: string;
  patient_id: string;
  location_id: string;
  location_name: string;
  prescribed_drug_id: string;
  drug_id: string;
  item_name: string;
  schedule: string;
  controlled: boolean;
  substitution_reason: string | null;
  quantity: number;
  dispensed_at: Date;
  dispensed_by_name: string;
  batches: {
    batchId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    returnedQuantity: number;
  }[];
  returns: {
    id: string;
    reason: string;
    returnedAt: string;
    returnedByName: string;
    lines: { batchId: string; batchNumber: string; quantity: number; wasted: boolean }[];
  }[];
}

const DISPENSES = `select d.id, d.order_id, d.prescription_id, d.encounter_id, d.patient_id,
    d.location_id, l.name as location_name, d.prescribed_drug_id, d.drug_id, d.item_name,
    d.schedule, d.controlled, d.substitution_reason, d.quantity, d.dispensed_at,
    coalesce(u.name, '') as dispensed_by_name,
    coalesce((
      select json_agg(json_build_object(
          'batchId', dl.batch_id, 'batchNumber', b.batch_number,
          'expiryDate', to_char(b.expiry_date, 'YYYY-MM-DD'), 'quantity', dl.quantity,
          'returnedQuantity', coalesce((
            select sum(rl.quantity) from dispense_return_lines rl
            where rl.tenant_id = dl.tenant_id and rl.dispense_id = dl.dispense_id
              and rl.batch_id = dl.batch_id
          ), 0))
        order by b.expiry_date, b.batch_key)
      from dispense_lines dl
      join stock_batches b on b.tenant_id = dl.tenant_id and b.id = dl.batch_id
      where dl.tenant_id = d.tenant_id and dl.dispense_id = d.id
    ), '[]'::json) as batches,
    coalesce((
      select json_agg(json_build_object(
          'id', r.id, 'reason', r.reason,
          'returnedAt', to_char(r.returned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'returnedByName', coalesce(ru.name, ''),
          'lines', (
            select json_agg(json_build_object(
                'batchId', rl.batch_id, 'batchNumber', rb.batch_number,
                'quantity', rl.quantity, 'wasted', rl.wasted)
              order by rb.expiry_date, rb.batch_key, rl.wasted)
            from dispense_return_lines rl
            join stock_batches rb on rb.tenant_id = rl.tenant_id and rb.id = rl.batch_id
            where rl.tenant_id = r.tenant_id and rl.return_id = r.id
          ))
        order by r.returned_at, r.id)
      from dispense_returns r
      left join users ru on ru.id = r.returned_by
      where r.tenant_id = d.tenant_id and r.dispense_id = d.id
    ), '[]'::json) as returns
  from dispenses d
  join stock_locations l on l.tenant_id = d.tenant_id and l.id = d.location_id
  left join users u on u.id = d.dispensed_by`;

/** A prescription's dispenses, oldest first. */
export async function dispensesOf(
  client: pg.ClientBase,
  prescriptionId: string,
): Promise<DispenseRow[]> {
  const { rows } = await client.query<DispenseRow>(
    `${DISPENSES} where d.prescription_id = $1 order by d.dispensed_at, d.id`,
    [prescriptionId],
  );
  return rows;
}

export async function findDispense(client: pg.ClientBase, id: string): Promise<DispenseRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DispenseRow>(`${DISPENSES} where d.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Writes a dispense, once its stock is taken out; its lines follow. */
export async function insertDispense(
  client: pg.ClientBase,
  dispense: {
    id: string;
    orderId: string;
    prescriptionId: string;
    encounterId: string;
    patientId: string;
    locationId: string;
    prescribedDrugId: string;
    drugId: string;
    substitutionReason: string | null;
    itemName: string;
    schedule: string;
    controlled: boolean;
    quantity: number;
    dispensedBy: string;
  },
): Promise<void> {
  await client.query(
    `insert into dispenses (id, tenant_id, order_id, prescription_id, encounter_id, patient_id,
       location_id, prescribed_drug_id, drug_id, substitution_reason, item_name, schedule,
       controlled, quantity, dispensed_by)
     values ($14, app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      dispense.orderId,
      dispense.prescriptionId,
      dispense.encounterId,
      dispense.patientId,
      dispense.locationId,
      dispense.prescribedDrugId,
      dispense.drugId,
      dispense.substitutionReason,
      dispense.itemName,
      dispense.schedule,
      dispense.controlled,
      dispense.quantity,
      dispense.dispensedBy,
      dispense.id,
    ],
  );
}

export async function insertDispenseLine(
  client: pg.ClientBase,
  line: {
    dispenseId: string;
    drugId: string;
    batchId: string;
    quantity: number;
    ledgerEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into dispense_lines (tenant_id, dispense_id, drug_id, batch_id, quantity, ledger_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5)`,
    [line.dispenseId, line.drugId, line.batchId, line.quantity, line.ledgerEntryId],
  );
}

/** Holds the dispense against another return of it until the transaction ends. */
export async function lockDispense(client: pg.ClientBase, dispenseId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended('dispense:' || $1, 0))`, [
    dispenseId,
  ]);
}

/** The prescription a return of a dispense belongs to: a repeat's answer. */
export async function prescriptionOfReturn(
  client: pg.ClientBase,
  returnId: string,
): Promise<string | null> {
  if (!UUID.test(returnId)) return null;
  const { rows } = await client.query<{ prescription_id: string }>(
    `select d.prescription_id from dispense_returns r
     join dispenses d on d.tenant_id = r.tenant_id and d.id = r.dispense_id
     where r.id = $1`,
    [returnId],
  );
  return rows[0]?.prescription_id ?? null;
}

/** Writes a return of a dispense, once its stock is moved; its lines follow. */
export async function insertDispenseReturn(
  client: pg.ClientBase,
  value: { id: string; dispenseId: string; reason: string; returnedBy: string },
): Promise<void> {
  await client.query(
    `insert into dispense_returns (id, tenant_id, dispense_id, reason, returned_by)
     values ($1, app_tenant_id(), $2, $3, $4)`,
    [value.id, value.dispenseId, value.reason, value.returnedBy],
  );
}

export async function insertDispenseReturnLine(
  client: pg.ClientBase,
  line: {
    returnId: string;
    dispenseId: string;
    batchId: string;
    quantity: number;
    wasted: boolean;
    ledgerEntryId: string;
    wasteEntryId: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into dispense_return_lines (tenant_id, return_id, dispense_id, batch_id, quantity,
       wasted, ledger_entry_id, waste_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      line.returnId,
      line.dispenseId,
      line.batchId,
      line.quantity,
      line.wasted,
      line.ledgerEntryId,
      line.wasteEntryId,
    ],
  );
}
