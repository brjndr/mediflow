import type pg from 'pg';
import type { OrderStatus, ReturnReason } from './schemas.js';

/**
 * Purchasing's SQL. Every statement runs on the request's own transaction, so row-level security
 * limits it to the active hospital: no statement here names a tenant. Item, place and staff names
 * are read from their tables in the lists' SQL, as inventory reads them; checking an item goes
 * through `stockableDrug` from `features/drugs`, and stock moves only through inventory's
 * `stockReceive` and `stockOut`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** Whether an error is the database refusing a row because of this constraint. */
export const isViolation = (error: unknown, constraint: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ['23505', '23514'].includes(String((error as { code?: unknown }).code)) &&
  (error as { constraint?: unknown }).constraint === constraint;

// --- cursors -----------------------------------------------------------------------------------

const encodeCursor = (values: string[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

/** An instant as the cursors hold it: UTC, to the microsecond. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const PART = {
  text: (value: string) => [...value].length <= 400 && !value.includes('\u0000'),
  instant: (value: string) => INSTANT.test(value) && !Number.isNaN(Date.parse(value)),
  uuid: (value: string) => UUID.test(value),
};

/** The parts of a cursor, each checked for its kind; null for anything else, so it is a 400. */
function decodeCursor(cursor: string, kinds: (keyof typeof PART)[]): string[] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== kinds.length) return null;
    const fits = value.every((each, index) => {
      const kind = kinds[index];
      return typeof each === 'string' && kind !== undefined && PART[kind](each);
    });
    return fits ? (value as string[]) : null;
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

const exact = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** An item as a line reads it: generic name, strength and brand. */
const ITEM_NAME = `d.generic_name || coalesce(' ' || d.strength, '') || coalesce(' (' || d.brand_name || ')', '')`;

/** The next number of a kind at the hospital, held until the transaction ends. */
export async function nextNumber(
  client: pg.ClientBase,
  kind: 'order' | 'receipt' | 'return',
): Promise<number> {
  const { rows } = await client.query<{ last_number: number }>(
    `insert into purchasing_counters as c (tenant_id, kind, last_number)
     values (app_tenant_id(), $1, 1)
     on conflict (tenant_id, kind) do update set last_number = c.last_number + 1
     returning c.last_number`,
    [kind],
  );
  const number = rows[0]?.last_number;
  if (number === undefined) throw new Error('no number was given');
  return number;
}

// --- suppliers ---------------------------------------------------------------------------------

export interface SupplierRow {
  id: string;
  tenant_id: string;
  name: string;
  name_lower: string;
  gstin: string | null;
  drug_licence: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  archived: boolean;
  version: number;
}

const SUPPLIERS = `select id, tenant_id, name, name_lower, gstin, drug_licence, phone, email, address,
  archived, version from suppliers`;

/** A page of the suppliers in use (or archived), by name, of a name with `q` in it. Null: a bad cursor. */
export async function listSuppliers(
  client: pg.ClientBase,
  {
    archived,
    q,
    cursor,
    limit,
  }: { archived: boolean; q: string | null; cursor?: string; limit: number },
): Promise<Page<SupplierRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, ['text', 'uuid']);
  if (after === null) return null;
  // The term is matched as text, never as a pattern: its own % and _ match themselves.
  const term = q === null ? null : q.toLowerCase();
  const { rows } = await client.query<SupplierRow>(
    `${SUPPLIERS}
     where archived = $1 and ($2::text is null or strpos(name_lower, $2) > 0)
       and ($3::text is null or (name_lower, id) > ($3, $4::uuid))
     order by name_lower, id limit $5`,
    [archived, term, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.name_lower, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from suppliers
       where archived = $1 and ($2::text is null or strpos(name_lower, $2) > 0)`,
      [archived, term],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findSupplier(client: pg.ClientBase, id: string): Promise<SupplierRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<SupplierRow>(`${SUPPLIERS} where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The supplier, held until the transaction ends: `for share` to order from it. */
export async function lockSupplier(
  client: pg.ClientBase,
  id: string,
  strength: 'update' | 'share' = 'update',
): Promise<SupplierRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<SupplierRow>(
    `${SUPPLIERS} where id = $1 for ${strength === 'update' ? 'update' : 'share'}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function supplierNameTaken(
  client: pg.ClientBase,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from suppliers where name_lower = lower($1) and ($2::uuid is null or id <> $2)',
    [name, exceptId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export interface SupplierFields {
  name: string;
  gstin: string | null;
  drugLicence: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

export async function insertSupplier(
  client: pg.ClientBase,
  fields: SupplierFields,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into suppliers (tenant_id, name, gstin, drug_licence, phone, email, address)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
    [fields.name, fields.gstin, fields.drugLicence, fields.phone, fields.email, fields.address],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('supplier was not created');
  return id;
}

export async function updateSupplier(
  client: pg.ClientBase,
  id: string,
  fields: SupplierFields & { archived: boolean },
): Promise<void> {
  await client.query(
    `update suppliers set name = $2, gstin = $3, drug_licence = $4, phone = $5, email = $6,
       address = $7, archived = $8
     where id = $1`,
    [
      id,
      fields.name,
      fields.gstin,
      fields.drugLicence,
      fields.phone,
      fields.email,
      fields.address,
      fields.archived,
    ],
  );
}

/** Whether the supplier has an order that may still bring goods. */
export async function supplierHasOpenOrder(client: pg.ClientBase, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from purchase_orders
     where supplier_id = $1 and status in ('draft', 'submitted', 'approved', 'partly_received') limit 1`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

// --- purchase orders ---------------------------------------------------------------------------

export interface OrderRow {
  id: string;
  tenant_id: string;
  number: number;
  supplier_id: string;
  supplier_name: string;
  location_id: string;
  location_name: string;
  note: string | null;
  status: OrderStatus;
  total_minor: string;
  line_count: number;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  created_at_exact: string;
  edited_by: string;
  submitted_by: string | null;
  submitted_by_name: string | null;
  submitted_at: Date | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  ended_by_name: string | null;
  ended_at: Date | null;
  end_note: string | null;
  version: number;
}

const ORDERS = `
  select o.id, o.tenant_id, o.number, o.supplier_id, s.name as supplier_name, o.location_id,
    l.name as location_name, o.note, o.status,
    coalesce(t.total, 0)::text as total_minor, coalesce(t.lines, 0)::int as line_count,
    o.created_by, cu.name as created_by_name, o.created_at, ${exact('o.created_at')} as created_at_exact,
    o.edited_by, o.submitted_by, su.name as submitted_by_name, o.submitted_at,
    au.name as approved_by_name, o.approved_at,
    eu.name as ended_by_name, o.ended_at, o.end_note, o.version
  from purchase_orders o
  join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
  join stock_locations l on l.tenant_id = o.tenant_id and l.id = o.location_id
  left join lateral (
    select sum(ol.quantity::bigint * ol.unit_cost_minor) as total, count(*) as lines
    from purchase_order_lines ol where ol.tenant_id = o.tenant_id and ol.order_id = o.id
  ) t on true
  left join users cu on cu.id = o.created_by
  left join users su on su.id = o.submitted_by
  left join users au on au.id = o.approved_by
  left join users eu on eu.id = o.ended_by`;

/** A page of the orders, newest first, of a status and a supplier. Null: a bad cursor. */
export async function listOrders(
  client: pg.ClientBase,
  {
    status,
    supplierId,
    cursor,
    limit,
  }: { status: OrderStatus | null; supplierId: string | null; cursor?: string; limit: number },
): Promise<Page<OrderRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, ['instant', 'uuid']);
  if (after === null) return null;
  const filter = `($1::text is null or o.status = $1) and ($2::uuid is null or o.supplier_id = $2)`;
  const { rows } = await client.query<OrderRow>(
    `${ORDERS}
     where ${filter} and ($3::timestamptz is null or (o.created_at, o.id) < ($3, $4::uuid))
     order by o.created_at desc, o.id desc limit $5`,
    [status, supplierId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.created_at_exact, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from purchase_orders o where ${filter}`,
      [status, supplierId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findOrder(client: pg.ClientBase, id: string): Promise<OrderRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<OrderRow>(`${ORDERS} where o.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The order, held until the transaction ends: it moves once, and is received one at a time. */
export async function lockOrder(client: pg.ClientBase, id: string): Promise<OrderRow | null> {
  if (!UUID.test(id)) return null;
  const locked = await client.query('select 1 from purchase_orders where id = $1 for update', [id]);
  return locked.rowCount === 1 ? findOrder(client, id) : null;
}

export interface OrderLineRow {
  id: string;
  line_number: number;
  drug_id: string;
  item_name: string;
  unit: string | null;
  quantity: number;
  unit_cost_minor: string;
  received_quantity: number;
}

export async function orderLines(client: pg.ClientBase, orderId: string): Promise<OrderLineRow[]> {
  const { rows } = await client.query<OrderLineRow>(
    `select ol.id, ol.line_number, ol.drug_id, ${ITEM_NAME} as item_name, d.unit, ol.quantity,
       ol.unit_cost_minor::text as unit_cost_minor,
       coalesce((select sum(rl.quantity) from goods_receipt_lines rl
                 where rl.tenant_id = ol.tenant_id and rl.order_line_id = ol.id), 0)::int as received_quantity
     from purchase_order_lines ol
     join drugs d on d.tenant_id = ol.tenant_id and d.id = ol.drug_id
     where ol.order_id = $1
     order by ol.line_number`,
    [orderId],
  );
  return rows;
}

export interface OrderFields {
  supplierId: string;
  locationId: string;
  note: string | null;
}

export async function insertOrder(
  client: pg.ClientBase,
  fields: OrderFields & { number: number; createdBy: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into purchase_orders (tenant_id, number, supplier_id, location_id, note, created_by, edited_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $5) returning id`,
    [fields.number, fields.supplierId, fields.locationId, fields.note, fields.createdBy],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('order was not created');
  return id;
}

/** Changes a draft, and records who changed it: that person may not approve it. */
export async function updateOrderFields(
  client: pg.ClientBase,
  id: string,
  fields: OrderFields & { editedBy: string },
): Promise<void> {
  await client.query(
    'update purchase_orders set supplier_id = $2, location_id = $3, note = $4, edited_by = $5 where id = $1',
    [id, fields.supplierId, fields.locationId, fields.note, fields.editedBy],
  );
}

/** Replaces a draft's lines, numbered in the order given. */
export async function replaceOrderLines(
  client: pg.ClientBase,
  orderId: string,
  lines: { drugId: string; quantity: number; unitCostMinor: number }[],
): Promise<void> {
  await client.query('delete from purchase_order_lines where order_id = $1', [orderId]);
  await client.query(
    `insert into purchase_order_lines (tenant_id, order_id, line_number, drug_id, quantity, unit_cost_minor)
     select app_tenant_id(), $1, n, drug_id, quantity, unit_cost_minor
     from unnest($2::uuid[], $3::int[], $4::bigint[]) with ordinality as l(drug_id, quantity, unit_cost_minor, n)`,
    [
      orderId,
      lines.map((line) => line.drugId),
      lines.map((line) => line.quantity),
      lines.map((line) => line.unitCostMinor),
    ],
  );
}

export async function moveOrder(
  client: pg.ClientBase,
  id: string,
  step:
    | { status: 'submitted'; by: string }
    | { status: 'approved'; by: string }
    | { status: 'partly_received' | 'received' }
    | { status: 'cancelled' | 'closed'; by: string; note: string },
): Promise<void> {
  switch (step.status) {
    case 'submitted':
      await client.query(
        `update purchase_orders set status = 'submitted', submitted_by = $2, submitted_at = now() where id = $1`,
        [id, step.by],
      );
      return;
    case 'approved':
      await client.query(
        `update purchase_orders set status = 'approved', approved_by = $2, approved_at = now() where id = $1`,
        [id, step.by],
      );
      return;
    case 'partly_received':
    case 'received':
      // Also when the status stays: the update moves the version, as the lines' received units changed.
      await client.query('update purchase_orders set status = $2 where id = $1', [id, step.status]);
      return;
    case 'cancelled':
    case 'closed':
      await client.query(
        `update purchase_orders set status = $2, ended_by = $3, ended_at = now(), end_note = $4 where id = $1`,
        [id, step.status, step.by, step.note],
      );
      return;
  }
}

// --- goods receipts ----------------------------------------------------------------------------

export interface ReceiptRow {
  id: string;
  tenant_id: string;
  number: number;
  order_id: string;
  order_number: number;
  supplier_id: string;
  supplier_name: string;
  location_id: string;
  location_name: string;
  supplier_invoice: string | null;
  note: string | null;
  total_minor: string;
  line_count: number;
  received_by_name: string | null;
  received_at: Date;
  received_at_exact: string;
}

const RECEIPTS = `
  select r.id, r.tenant_id, r.number, r.order_id, o.number as order_number, r.supplier_id,
    s.name as supplier_name, r.location_id, l.name as location_name, r.supplier_invoice, r.note,
    coalesce(t.total, 0)::text as total_minor, coalesce(t.lines, 0)::int as line_count,
    ru.name as received_by_name, r.received_at, ${exact('r.received_at')} as received_at_exact
  from goods_receipts r
  join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
  join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
  join stock_locations l on l.tenant_id = r.tenant_id and l.id = r.location_id
  left join lateral (
    select sum(rl.quantity::bigint * rl.unit_cost_minor) as total, count(*) as lines
    from goods_receipt_lines rl where rl.tenant_id = r.tenant_id and rl.receipt_id = r.id
  ) t on true
  left join users ru on ru.id = r.received_by`;

/** A page of the receipts, newest first, of an order and a supplier. Null: a bad cursor. */
export async function listReceipts(
  client: pg.ClientBase,
  {
    orderId,
    supplierId,
    cursor,
    limit,
  }: { orderId: string | null; supplierId: string | null; cursor?: string; limit: number },
): Promise<Page<ReceiptRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, ['instant', 'uuid']);
  if (after === null) return null;
  const filter = `($1::uuid is null or r.order_id = $1) and ($2::uuid is null or r.supplier_id = $2)`;
  const { rows } = await client.query<ReceiptRow>(
    `${RECEIPTS}
     where ${filter} and ($3::timestamptz is null or (r.received_at, r.id) < ($3, $4::uuid))
     order by r.received_at desc, r.id desc limit $5`,
    [orderId, supplierId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.received_at_exact, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from goods_receipts r where ${filter}`,
      [orderId, supplierId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findReceipt(client: pg.ClientBase, id: string): Promise<ReceiptRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ReceiptRow>(`${RECEIPTS} where r.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The receipt, held until the transaction ends, so two returns of it take their turn. */
export async function lockReceipt(client: pg.ClientBase, id: string): Promise<ReceiptRow | null> {
  // Found first, so only a receipt of this hospital is ever locked.
  const found = await findReceipt(client, id);
  if (!found) return null;
  // The app may not lock a row it may not update, and a receipt is never updated: an advisory
  // lock on its id instead.
  await client.query("select pg_advisory_xact_lock(hashtextextended('receipt:' || $1::text, 0))", [
    found.id,
  ]);
  return found;
}

export interface ReceiptLineRow {
  id: string;
  line_number: number;
  order_line_id: string;
  drug_id: string;
  item_name: string;
  unit: string | null;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  mrp_minor: string | null;
  quantity: number;
  unit_cost_minor: string;
  returned_quantity: number;
}

export async function receiptLines(
  client: pg.ClientBase,
  receiptId: string,
): Promise<ReceiptLineRow[]> {
  const { rows } = await client.query<ReceiptLineRow>(
    `select rl.id, rl.line_number, rl.order_line_id, rl.drug_id, ${ITEM_NAME} as item_name, d.unit,
       rl.batch_id, b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date,
       b.mrp_minor::text as mrp_minor, rl.quantity, rl.unit_cost_minor::text as unit_cost_minor,
       coalesce((select sum(pl.quantity) from purchase_return_lines pl
                 where pl.tenant_id = rl.tenant_id and pl.receipt_line_id = rl.id), 0)::int as returned_quantity
     from goods_receipt_lines rl
     join drugs d on d.tenant_id = rl.tenant_id and d.id = rl.drug_id
     join stock_batches b on b.tenant_id = rl.tenant_id and b.id = rl.batch_id
     where rl.receipt_id = $1
     order by rl.line_number`,
    [receiptId],
  );
  return rows;
}

export async function insertReceipt(
  client: pg.ClientBase,
  receipt: {
    number: number;
    orderId: string;
    supplierId: string;
    locationId: string;
    supplierInvoice: string | null;
    note: string | null;
    receivedBy: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into goods_receipts (tenant_id, number, order_id, supplier_id, location_id, supplier_invoice, note, received_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      receipt.number,
      receipt.orderId,
      receipt.supplierId,
      receipt.locationId,
      receipt.supplierInvoice,
      receipt.note,
      receipt.receivedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('receipt was not created');
  return id;
}

export async function insertReceiptLine(
  client: pg.ClientBase,
  line: {
    receiptId: string;
    orderId: string;
    orderLineId: string;
    lineNumber: number;
    drugId: string;
    batchId: string;
    quantity: number;
    unitCostMinor: number;
    ledgerEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into goods_receipt_lines (tenant_id, receipt_id, order_id, order_line_id, line_number, drug_id,
       batch_id, quantity, unit_cost_minor, ledger_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      line.receiptId,
      line.orderId,
      line.orderLineId,
      line.lineNumber,
      line.drugId,
      line.batchId,
      line.quantity,
      line.unitCostMinor,
      line.ledgerEntryId,
    ],
  );
}

// --- returns to the supplier -------------------------------------------------------------------

export interface ReturnRow {
  id: string;
  tenant_id: string;
  number: number;
  receipt_id: string;
  receipt_number: number;
  supplier_id: string;
  supplier_name: string;
  location_id: string;
  location_name: string;
  reason: ReturnReason;
  note: string | null;
  returned_by_name: string | null;
  returned_at: Date;
  returned_at_exact: string;
}

const RETURNS = `
  select p.id, p.tenant_id, p.number, p.receipt_id, r.number as receipt_number, p.supplier_id,
    s.name as supplier_name, p.location_id, l.name as location_name, p.reason, p.note,
    pu.name as returned_by_name, p.returned_at, ${exact('p.returned_at')} as returned_at_exact
  from purchase_returns p
  join goods_receipts r on r.tenant_id = p.tenant_id and r.id = p.receipt_id
  join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id
  join stock_locations l on l.tenant_id = p.tenant_id and l.id = p.location_id
  left join users pu on pu.id = p.returned_by`;

/** A page of the returns, newest first, of a receipt and a supplier. Null: a bad cursor. */
export async function listReturns(
  client: pg.ClientBase,
  {
    receiptId,
    supplierId,
    cursor,
    limit,
  }: { receiptId: string | null; supplierId: string | null; cursor?: string; limit: number },
): Promise<Page<ReturnRow> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, ['instant', 'uuid']);
  if (after === null) return null;
  const filter = `($1::uuid is null or p.receipt_id = $1) and ($2::uuid is null or p.supplier_id = $2)`;
  const { rows } = await client.query<ReturnRow>(
    `${RETURNS}
     where ${filter} and ($3::timestamptz is null or (p.returned_at, p.id) < ($3, $4::uuid))
     order by p.returned_at desc, p.id desc limit $5`,
    [receiptId, supplierId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  const result = paged(rows, limit, (row) => [row.returned_at_exact, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from purchase_returns p where ${filter}`,
      [receiptId, supplierId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findReturn(client: pg.ClientBase, id: string): Promise<ReturnRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ReturnRow>(`${RETURNS} where p.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface ReturnLineRow {
  id: string;
  return_id: string;
  receipt_line_id: string;
  drug_id: string;
  item_name: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  unit_cost_minor: string;
}

/** The lines of these returns, in their receipt's order. */
export async function returnLines(
  client: pg.ClientBase,
  returnIds: string[],
): Promise<ReturnLineRow[]> {
  if (returnIds.length === 0) return [];
  const { rows } = await client.query<ReturnLineRow>(
    `select pl.id, pl.return_id, pl.receipt_line_id, rl.drug_id, ${ITEM_NAME} as item_name, pl.batch_id,
       b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') as expiry_date, pl.quantity,
       rl.unit_cost_minor::text as unit_cost_minor
     from purchase_return_lines pl
     join goods_receipt_lines rl on rl.tenant_id = pl.tenant_id and rl.id = pl.receipt_line_id
     join drugs d on d.tenant_id = rl.tenant_id and d.id = rl.drug_id
     join stock_batches b on b.tenant_id = pl.tenant_id and b.id = pl.batch_id
     where pl.return_id = any($1::uuid[])
     order by pl.return_id, rl.line_number`,
    [returnIds],
  );
  return rows;
}

export async function insertReturn(
  client: pg.ClientBase,
  value: {
    number: number;
    receiptId: string;
    supplierId: string;
    locationId: string;
    reason: ReturnReason;
    note: string | null;
    returnedBy: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into purchase_returns (tenant_id, number, receipt_id, supplier_id, location_id, reason, note, returned_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      value.number,
      value.receiptId,
      value.supplierId,
      value.locationId,
      value.reason,
      value.note,
      value.returnedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('return was not created');
  return id;
}

export async function insertReturnLine(
  client: pg.ClientBase,
  line: {
    returnId: string;
    receiptId: string;
    receiptLineId: string;
    batchId: string;
    quantity: number;
    ledgerEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into purchase_return_lines (tenant_id, return_id, receipt_id, receipt_line_id, batch_id, quantity, ledger_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
    [
      line.returnId,
      line.receiptId,
      line.receiptLineId,
      line.batchId,
      line.quantity,
      line.ledgerEntryId,
    ],
  );
}
