import type pg from 'pg';
import { searchTerm } from '../../core/http/text.js';
import { columnsOf, discountOf, inputFrom, spread, type DiscountInput } from './discount.js';
import { taxRatesOf, type TaxClass } from './tax.js';

/**
 * The SQL of billing (#114). Every statement runs on the request's own transaction, so row-level
 * security limits it to the active hospital. Money is bigint in the database and read as text,
 * then turned into a number: every amount is kept within a safe integer.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);
export const num = (value: string | number | null | undefined): number => Number(value ?? 0);

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const EXACT = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const encodeCursor = (kind: string, at: string, id: string): string =>
  Buffer.from(JSON.stringify([kind, at, id])).toString('base64url');

/** A cursor `[kind, instant, id]` of this kind, or null for anything else. */
export function decodeCursor(cursor: string, kind: string): [string, string] | null {
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

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  total?: number;
}

export interface EncounterRow {
  id: string;
  patient_id: string;
  status: string;
}

export async function findEncounter(
  client: pg.ClientBase,
  id: string,
): Promise<EncounterRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<EncounterRow>(
    'select id, patient_id, status from encounters where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export interface ChargeRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  source: string;
  description: string;
  quantity: number;
  unit_price_minor: string;
  total_minor: string;
  status: string;
  invoice_id: string | null;
  flag: string | null;
  tax_class: string | null;
  posted_at: Date;
  at_exact: string;
  total: number;
}

export async function findCharge(client: pg.ClientBase, id: string): Promise<ChargeRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<ChargeRow>(
    `select c.id, c.tenant_id, c.encounter_id, c.source, c.description, c.quantity,
       c.unit_price_minor::text, c.total_minor::text, c.status, c.invoice_id, c.flag, c.tax_class,
       c.posted_at,
       ${EXACT('c.posted_at')} as at_exact, 1 as total
     from charges c where c.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCharges(
  client: pg.ClientBase,
  options: { encounterId: string; status?: string; cursor?: string; limit: number },
): Promise<Page<ChargeRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'charges') : undefined;
  if (after === null) return null;
  const { rows } = await client.query<ChargeRow>(
    `select c.id, c.tenant_id, c.encounter_id, c.source, c.description, c.quantity,
       c.unit_price_minor::text, c.total_minor::text, c.status, c.invoice_id, c.flag, c.tax_class,
       c.posted_at,
       ${EXACT('c.posted_at')} as at_exact, count(*) over ()::int as total
     from charges c
     where c.encounter_id = $1 and ($2::text is null or c.status = $2)
       and ($3::timestamptz is null or (c.posted_at, c.id) < ($3::timestamptz, $4::uuid))
     order by c.posted_at desc, c.id desc
     limit $5`,
    [
      options.encounterId,
      options.status ?? null,
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
      rows.length > options.limit && last ? encodeCursor('charges', last.at_exact, last.id) : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  number: string | null;
  status: string;
  total_minor: string;
  tax_minor: string;
  paid_minor: string;
  credited_minor: string;
  currency: string;
  version: number;
  created_at: Date;
  issued_at: Date | null;
  discount_minor: string;
  discount_status: string;
  discount_applied_by: string | null;
  discount_approved_at: Date | null;
  bill_discount_bp: number | null;
  bill_discount_amount_minor: string | null;
  bill_discount_reason: string | null;
  lines: {
    id: string;
    chargeId: string | null;
    source: string;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
    taxClass: string | null;
    taxRateBp: number;
    taxMinor: number;
    discountBp: number | null;
    discountAmountMinor: number | null;
    discountReason: string | null;
    discountMinor: number;
    billDiscountMinor: number;
  }[];
  at_exact: string;
  total: number;
}

const INVOICE_SELECT = `
  select i.id, i.tenant_id, i.encounter_id, i.patient_id,
    pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
    i.number, i.status, i.total_minor::text, i.tax_minor::text, i.paid_minor::text,
    i.credited_minor::text,
    i.currency, i.version, i.created_at, i.issued_at,
    i.discount_minor::text, i.discount_status, i.discount_applied_by, i.discount_approved_at,
    i.bill_discount_bp, i.bill_discount_amount_minor::text, i.bill_discount_reason,
    coalesce((select json_agg(json_build_object('id', l.id, 'chargeId', l.charge_id,
        'source', l.source, 'description', l.description, 'quantity', l.quantity,
        'unitPriceMinor', l.unit_price_minor, 'totalMinor', l.total_minor,
        'taxClass', l.tax_class, 'taxRateBp', l.tax_rate_bp, 'taxMinor', l.tax_minor,
        'discountBp', l.discount_bp, 'discountAmountMinor', l.discount_amount_minor,
        'discountReason', l.discount_reason, 'discountMinor', l.discount_minor,
        'billDiscountMinor', l.bill_discount_minor)
        order by l.line_number)
      from invoice_lines l where l.tenant_id = i.tenant_id and l.invoice_id = i.id), '[]') as lines,
    ${EXACT('i.created_at')} as at_exact, count(*) over ()::int as total
  from invoices i
  join patients pt on pt.tenant_id = i.tenant_id and pt.id = i.patient_id`;

export async function findInvoice(client: pg.ClientBase, id: string): Promise<InvoiceRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<InvoiceRow>(`${INVOICE_SELECT} where i.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listInvoices(
  client: pg.ClientBase,
  options: { encounterId: string; cursor?: string; limit: number },
): Promise<Page<InvoiceRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'invoices') : undefined;
  if (after === null) return null;
  const { rows } = await client.query<InvoiceRow>(
    `${INVOICE_SELECT}
     where i.encounter_id = $1
       and ($2::timestamptz is null or (i.created_at, i.id) < ($2::timestamptz, $3::uuid))
     order by i.created_at desc, i.id desc
     limit $4`,
    [options.encounterId, after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last ? encodeCursor('invoices', last.at_exact, last.id) : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export interface InvoiceSearch {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * Invoices of the hospital, newest first. Every word of the term must be in the invoice number,
 * the patient's name or the MRN, in any order.
 */
export async function searchInvoices(
  client: pg.ClientBase,
  options: InvoiceSearch,
): Promise<Page<InvoiceRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'invoices') : undefined;
  if (after === null) return null;
  const words = (searchTerm(options.q) ?? '').split(' ').filter(Boolean).slice(0, 6);
  const params: unknown[] = [
    after?.[0] ?? null,
    after?.[1] ?? null,
    options.status ?? null,
    options.from ?? null,
    options.to ?? null,
  ];
  const matches = words.map((word) => {
    params.push(likePattern(word));
    const at = `$${params.length}`;
    return `(i.number ilike ${at} or pt.first_name || ' ' || pt.last_name ilike ${at} or pt.mrn ilike ${at})`;
  });
  params.push(options.limit + 1);
  const { rows } = await client.query<InvoiceRow>(
    `${INVOICE_SELECT}
     where ($1::timestamptz is null or (i.created_at, i.id) < ($1::timestamptz, $2::uuid))
       and ($3::text is null or i.status = $3)
       and ($4::timestamptz is null or i.created_at >= $4)
       and ($5::timestamptz is null or i.created_at < $5)
       ${matches.map((match) => `and ${match}`).join(' ')}
     order by i.created_at desc, i.id desc
     limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last ? encodeCursor('invoices', last.at_exact, last.id) : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export interface LockedInvoice {
  id: string;
  encounter_id: string;
  patient_id: string;
  status: string;
  total_minor: string;
  paid_minor: string;
  credited_minor: string;
  version: number;
  discount_status: string;
  discount_applied_by: string | null;
}

/** Holds the invoice against every other change until the transaction ends. */
export async function lockInvoice(
  client: pg.ClientBase,
  id: string,
): Promise<LockedInvoice | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<LockedInvoice>(
    `select id, encounter_id, patient_id, status, total_minor::text, paid_minor::text,
       credited_minor::text, version,
       discount_status, discount_applied_by
     from invoices where id = $1 for update`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertDraft(
  client: pg.ClientBase,
  invoice: { id: string; encounterId: string; patientId: string; createdBy: string },
): Promise<void> {
  await client.query(
    `insert into invoices (id, tenant_id, encounter_id, patient_id, currency, created_by)
     select $1, t.id, $2, $3, t.currency, $4 from tenants t where t.id = app_tenant_id()`,
    [invoice.id, invoice.encounterId, invoice.patientId, invoice.createdBy],
  );
}

export interface ManualLineInput {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  /** The class the line is taxed as; null means no tax. */
  taxClass: TaxClass | null;
  discount: DiscountInput | null;
}

/** A line's own discount row, as it is stored. */
interface DiscountColumns {
  discount_bp: number | null;
  discount_amount_minor: string | null;
  discount_reason: string | null;
}
const discountOfRow = (row: DiscountColumns): DiscountInput | null =>
  inputFrom(row.discount_bp, row.discount_amount_minor, row.discount_reason);

/** The lines a draft holds that were typed in, as they are now. */
export async function manualLinesOf(
  client: pg.ClientBase,
  invoiceId: string,
): Promise<ManualLineInput[]> {
  const { rows } = await client.query<
    {
      description: string;
      quantity: number;
      unit_price_minor: string;
      tax_class: TaxClass | null;
    } & DiscountColumns
  >(
    `select description, quantity, unit_price_minor::text, tax_class, discount_bp,
       discount_amount_minor::text, discount_reason
     from invoice_lines
     where invoice_id = $1 and charge_id is null order by line_number`,
    [invoiceId],
  );
  return rows.map((row) => ({
    description: row.description,
    quantity: row.quantity,
    unitPriceMinor: num(row.unit_price_minor),
    taxClass: row.tax_class,
    discount: discountOfRow(row),
  }));
}

/** What a draft carries now: the discount of each charge line, and of the bill. */
export interface DraftDiscounts {
  charges: Record<string, DiscountInput | null>;
  bill: DiscountInput | null;
  status: string;
  appliedBy: string | null;
  approvedMinor: number | null;
  approvedGrossMinor: number | null;
  discountMinor: number;
}

export async function discountsOf(
  client: pg.ClientBase,
  invoiceId: string,
): Promise<DraftDiscounts> {
  const lines = await client.query<DiscountColumns & { charge_id: string }>(
    `select charge_id, discount_bp, discount_amount_minor::text, discount_reason
     from invoice_lines where invoice_id = $1 and charge_id is not null`,
    [invoiceId],
  );
  const invoice = await client.query<{
    bill_discount_bp: number | null;
    bill_discount_amount_minor: string | null;
    bill_discount_reason: string | null;
    discount_status: string;
    discount_applied_by: string | null;
    discount_approved_minor: string | null;
    discount_approved_gross_minor: string | null;
    discount_minor: string;
  }>(
    `select bill_discount_bp, bill_discount_amount_minor::text, bill_discount_reason,
       discount_status, discount_applied_by, discount_approved_minor::text,
       discount_approved_gross_minor::text, discount_minor::text
     from invoices where id = $1`,
    [invoiceId],
  );
  const row = invoice.rows[0];
  return {
    charges: Object.fromEntries(lines.rows.map((line) => [line.charge_id, discountOfRow(line)])),
    bill: row
      ? inputFrom(row.bill_discount_bp, row.bill_discount_amount_minor, row.bill_discount_reason)
      : null,
    status: row?.discount_status ?? 'none',
    appliedBy: row?.discount_applied_by ?? null,
    approvedMinor: row?.discount_approved_minor == null ? null : num(row.discount_approved_minor),
    approvedGrossMinor:
      row?.discount_approved_gross_minor == null ? null : num(row.discount_approved_gross_minor),
    discountMinor: num(row?.discount_minor),
  };
}

export interface HeldCharge {
  id: string;
  source: string;
  description: string;
  quantity: number;
  unit_price_minor: string;
  tax_class: TaxClass | null;
}

/**
 * Locks the charges named (in id order, so two drafts take them in one order) and returns the
 * ones that may go on this draft: pending, of this visit, and held by no other draft.
 */
export async function claimCharges(
  client: pg.ClientBase,
  invoiceId: string,
  encounterId: string,
  chargeIds: string[],
): Promise<HeldCharge[]> {
  const { rows } = await client.query<HeldCharge & { status: string; invoice_id: string | null }>(
    `select id, source, description, quantity, unit_price_minor::text, tax_class, status, invoice_id
     from charges where encounter_id = $1 and id = any($2::uuid[])
     order by id for update`,
    [encounterId, chargeIds],
  );
  const usable = rows.filter(
    (row) => row.status === 'pending' && (row.invoice_id === null || row.invoice_id === invoiceId),
  );
  return usable.length === chargeIds.length ? usable : [];
}

/** Lets go of the charges the draft held that are no longer on it, and takes the chosen ones. */
export async function holdCharges(
  client: pg.ClientBase,
  invoiceId: string,
  chargeIds: string[],
): Promise<void> {
  await client.query(
    `update charges set invoice_id = null
     where invoice_id = $1 and status = 'pending' and not (id = any($2::uuid[]))`,
    [invoiceId, chargeIds],
  );
  await client.query(`update charges set invoice_id = $1 where id = any($2::uuid[])`, [
    invoiceId,
    chargeIds,
  ]);
}

export interface DraftAmounts {
  /** What is owed: the lines less their discounts, and the tax on what is left. */
  totalMinor: number;
  taxMinor: number;
  /** Line discounts and the bill discount together, before tax. */
  discountMinor: number;
  /** The lines before any discount and before tax. */
  grossMinor: number;
}

export type DraftLine = HeldCharge & { discount: DiscountInput | null };

/**
 * Writes the lines of a draft: each line's own discount, then the bill discount spread over what
 * the lines cost after theirs, and the database works out each line's tax on what is left.
 */
export async function replaceLines(
  client: pg.ClientBase,
  invoiceId: string,
  charges: DraftLine[],
  manual: ManualLineInput[],
  bill: DiscountInput | null,
): Promise<DraftAmounts> {
  await client.query('delete from invoice_lines where invoice_id = $1', [invoiceId]);
  // The rates in effect now: a draft is priced when it is saved, an issued invoice keeps them.
  const rates = await taxRatesOf(client);
  const rateOf = (taxClass: TaxClass | null) => (taxClass === null ? 0 : rates[taxClass]);
  const entries = [
    ...charges.map((charge) => ({
      chargeId: charge.id as string | null,
      source: charge.source,
      description: charge.description,
      quantity: charge.quantity,
      price: BigInt(charge.unit_price_minor),
      taxClass: charge.tax_class,
      discount: charge.discount,
    })),
    ...manual.map((line) => ({
      chargeId: null as string | null,
      source: 'manual',
      description: line.description,
      quantity: line.quantity,
      price: BigInt(line.unitPriceMinor),
      taxClass: line.taxClass,
      discount: line.discount,
    })),
  ];
  const gross = entries.map((entry) => BigInt(entry.quantity) * entry.price);
  const own = entries.map((entry, index) => discountOf(gross[index] ?? 0n, entry.discount));
  const bases = gross.map((value, index) => value - (own[index] ?? 0n));
  const billTotal = discountOf(
    bases.reduce((a, b) => a + b, 0n),
    bill,
  );
  const shares = spread(bases, billTotal);
  for (const [index, entry] of entries.entries()) {
    const columns = columnsOf(entry.discount);
    await client.query(
      `insert into invoice_lines (tenant_id, invoice_id, line_number, charge_id, source,
         description, quantity, unit_price_minor, tax_class, tax_rate_bp, discount_bp,
         discount_amount_minor, discount_reason, bill_discount_minor)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        invoiceId,
        index + 1,
        entry.chargeId,
        entry.source,
        entry.description,
        entry.quantity,
        entry.price.toString(),
        entry.taxClass,
        rateOf(entry.taxClass),
        columns.bp,
        columns.amount,
        columns.reason,
        (shares[index] ?? 0n).toString(),
      ],
    );
  }
  const { rows } = await client.query<{
    total: string;
    tax: string;
    discount: string;
    gross: string;
  }>(
    `select coalesce(sum(total_minor - discount_minor - bill_discount_minor), 0)::text as total,
       coalesce(sum(tax_minor), 0)::text as tax,
       coalesce(sum(discount_minor + bill_discount_minor), 0)::text as discount,
       coalesce(sum(total_minor), 0)::text as gross
     from invoice_lines where invoice_id = $1`,
    [invoiceId],
  );
  const taxMinor = num(rows[0]?.tax);
  return {
    totalMinor: num(rows[0]?.total) + taxMinor,
    taxMinor,
    discountMinor: num(rows[0]?.discount),
    grossMinor: num(rows[0]?.gross),
  };
}

export interface DraftDiscountState {
  bill: DiscountInput | null;
  status: 'none' | 'pending' | 'approved';
  appliedBy: string | null;
}

/**
 * Saves a draft's amounts and discount standing. A status of `approved` keeps the approval it
 * already had; anything else clears it.
 */
export async function setDraftState(
  client: pg.ClientBase,
  invoiceId: string,
  amounts: DraftAmounts,
  state: DraftDiscountState,
  bumpVersion: boolean,
): Promise<void> {
  const bill = columnsOf(state.bill);
  await client.query(
    `update invoices set total_minor = $2, tax_minor = $3, discount_minor = $4,
       bill_discount_bp = $5, bill_discount_amount_minor = $6, bill_discount_reason = $7,
       discount_status = $8::text, discount_applied_by = $9,
       discount_approved_by = case when $8::text = 'approved' then discount_approved_by end,
       discount_approved_at = case when $8::text = 'approved' then discount_approved_at end,
       discount_approved_minor = case when $8::text = 'approved' then discount_approved_minor end,
       discount_approved_gross_minor =
         case when $8::text = 'approved' then discount_approved_gross_minor end,
       version = version + $10
     where id = $1`,
    [
      invoiceId,
      amounts.totalMinor,
      amounts.taxMinor,
      amounts.discountMinor,
      bill.bp,
      bill.amount,
      bill.reason,
      state.status,
      state.appliedBy,
      bumpVersion ? 1 : 0,
    ],
  );
}

/** A second person approves the discount on a draft, for the amount it stands at. */
export async function approveDiscount(
  client: pg.ClientBase,
  invoiceId: string,
  approver: string,
): Promise<void> {
  await client.query(
    `update invoices set discount_status = 'approved', discount_approved_by = $2,
       discount_approved_at = now(), discount_approved_minor = discount_minor,
       discount_approved_gross_minor = (
         select coalesce(sum(total_minor), 0) from invoice_lines where invoice_id = $1
       ),
       version = version + 1
     where id = $1`,
    [invoiceId, approver],
  );
}

/** Today at the hospital's clock gives the fiscal year, April to March: `2026-27`. */
export async function nextNumber(
  client: pg.ClientBase,
  series: 'invoice' | 'credit_note',
): Promise<{ number: string; fiscalYear: string }> {
  const { rows } = await client.query<{ fy: string }>(
    `select y || '-' || lpad(((y + 1) % 100)::text, 2, '0') as fy from (
       select case when extract(month from (now() at time zone timezone)) >= 4
         then extract(year from (now() at time zone timezone))::int
         else extract(year from (now() at time zone timezone))::int - 1 end as y
       from tenants where id = app_tenant_id()) t`,
  );
  const fiscalYear = rows[0]?.fy ?? '';
  // One row for each series and year, locked by the upsert until the transaction ends, so two
  // issues never share a number and a rolled-back issue leaves no gap.
  const counter = await client.query<{ last_number: number }>(
    `insert into invoice_counters (tenant_id, series, fiscal_year, last_number)
     values (app_tenant_id(), $1, $2, 1)
     on conflict (tenant_id, series, fiscal_year)
     do update set last_number = invoice_counters.last_number + 1
     returning last_number`,
    [series, fiscalYear],
  );
  const n = String(counter.rows[0]?.last_number ?? 0).padStart(6, '0');
  return { number: `${series === 'invoice' ? 'INV' : 'CN'}-${fiscalYear}-${n}`, fiscalYear };
}

export async function issueInvoice(
  client: pg.ClientBase,
  invoice: { id: string; number: string; fiscalYear: string; by: string; paid: boolean },
): Promise<void> {
  await client.query(
    `update charges set status = 'invoiced' where invoice_id = $1 and status = 'pending'`,
    [invoice.id],
  );
  await client.query(
    `update invoices set number = $2, fiscal_year = $3, issued_by = $4, issued_at = now(),
       status = $5, version = version + 1
     where id = $1`,
    [invoice.id, invoice.number, invoice.fiscalYear, invoice.by, invoice.paid ? 'paid' : 'issued'],
  );
}

export async function updateSettlement(
  client: pg.ClientBase,
  id: string,
  settlement: { paid: number; credited: number; status: string },
): Promise<void> {
  await client.query(
    `update invoices set paid_minor = $2, credited_minor = $3, status = $4, version = version + 1
     where id = $1`,
    [id, settlement.paid, settlement.credited, settlement.status],
  );
}

/** A void invoice lets go of its charges, so they can be billed again. */
export async function releaseCharges(client: pg.ClientBase, invoiceId: string): Promise<void> {
  await client.query(
    `update charges set status = 'pending', invoice_id = null
     where invoice_id = $1 and status = 'invoiced'`,
    [invoiceId],
  );
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  kind: string;
  amount_minor: string;
  method: string;
  reference: string | null;
  refund_of: string | null;
  reason: string | null;
  session_id: string | null;
  recorded_by_name: string;
  at: Date;
}

const PAYMENT_SELECT = `
  select p.id, p.invoice_id, p.kind, p.amount_minor::text, p.method, p.reference, p.refund_of,
    p.reason, p.session_id, coalesce(u.name, '') as recorded_by_name, p.at
  from payments p left join users u on u.id = p.recorded_by`;

export async function paymentsOf(client: pg.ClientBase, invoiceId: string): Promise<PaymentRow[]> {
  const { rows } = await client.query<PaymentRow>(
    `${PAYMENT_SELECT} where p.invoice_id = $1 order by p.at, p.id`,
    [invoiceId],
  );
  return rows;
}

export async function findPayment(client: pg.ClientBase, id: string): Promise<PaymentRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertPayment(
  client: pg.ClientBase,
  payment: {
    id: string;
    invoiceId: string;
    kind: 'payment' | 'refund';
    amountMinor: number;
    method: string;
    reference: string | null;
    refundOf: string | null;
    reason: string | null;
    sessionId: string | null;
    by: string;
  },
): Promise<void> {
  await client.query(
    `insert into payments (id, tenant_id, invoice_id, kind, amount_minor, method, reference,
       refund_of, reason, session_id, recorded_by)
     values ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      payment.id,
      payment.invoiceId,
      payment.kind,
      payment.amountMinor,
      payment.method,
      payment.reference,
      payment.refundOf,
      payment.reason,
      payment.sessionId,
      payment.by,
    ],
  );
}

/** What a payment still holds: its amount less the refunds already made of it. */
export async function refundableOf(client: pg.ClientBase, paymentId: string): Promise<number> {
  const { rows } = await client.query<{ left: string }>(
    `select (p.amount_minor - coalesce((select sum(r.amount_minor) from payments r
       where r.refund_of = p.id), 0))::text as left
     from payments p where p.id = $1`,
    [paymentId],
  );
  return num(rows[0]?.left);
}

export interface CreditNoteRow {
  id: string;
  invoice_id: string;
  number: string;
  amount_minor: string;
  reason: string;
  created_by_name: string;
  created_at: Date;
}

export async function creditNotesOf(
  client: pg.ClientBase,
  invoiceId: string,
): Promise<CreditNoteRow[]> {
  const { rows } = await client.query<CreditNoteRow>(
    `select c.id, c.invoice_id, c.number, c.amount_minor::text, c.reason,
       coalesce(u.name, '') as created_by_name, c.created_at
     from credit_notes c left join users u on u.id = c.created_by
     where c.invoice_id = $1 order by c.created_at, c.id`,
    [invoiceId],
  );
  return rows;
}

export async function insertCreditNote(
  client: pg.ClientBase,
  note: {
    id: string;
    invoiceId: string;
    number: string;
    fiscalYear: string;
    amountMinor: number;
    reason: string;
    by: string;
  },
): Promise<void> {
  await client.query(
    `insert into credit_notes (id, tenant_id, invoice_id, number, fiscal_year, amount_minor,
       reason, created_by)
     values ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7)`,
    [note.id, note.invoiceId, note.number, note.fiscalYear, note.amountMinor, note.reason, note.by],
  );
}

export interface SessionRow {
  id: string;
  opened_by: string;
  opened_by_name: string;
  opened_at: Date;
  opening_minor: string;
  closed_at: Date | null;
  expected_minor: string;
  counted_minor: string | null;
  note: string | null;
  totals: { method: string; paidMinor: number; refundedMinor: number }[];
  at_exact: string;
  total: number;
}

/**
 * Everything that moves money through a register session: payments and refunds on invoices, and
 * the deposits of a stay taken and paid back (#169), the same way.
 */
const MOVEMENTS = `
  select method, kind, amount_minor, session_id from payments
  union all select method, 'payment', amount_minor, session_id from deposits
  union all select method, 'refund', amount_minor, session_id from deposit_refunds`;

const SESSION_SELECT = `
  select s.id, s.opened_by, coalesce(u.name, '') as opened_by_name, s.opened_at,
    s.opening_minor::text, s.closed_at, s.counted_minor::text, s.note,
    coalesce(s.expected_minor, s.opening_minor + coalesce((select sum(case p.kind
       when 'payment' then p.amount_minor else -p.amount_minor end)
       from (${MOVEMENTS}) p where p.session_id = s.id), 0))::text as expected_minor,
    coalesce((select json_agg(json_build_object('method', t.method, 'paidMinor', t.paid,
        'refundedMinor', t.refunded) order by t.method)
      from (select p.method,
          coalesce(sum(p.amount_minor) filter (where p.kind = 'payment'), 0) as paid,
          coalesce(sum(p.amount_minor) filter (where p.kind = 'refund'), 0) as refunded
        from (${MOVEMENTS}) p where p.session_id = s.id group by p.method) t), '[]') as totals,
    ${EXACT('s.opened_at')} as at_exact, count(*) over ()::int as total
  from cash_register_sessions s left join users u on u.id = s.opened_by`;

export async function findSession(client: pg.ClientBase, id: string): Promise<SessionRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<SessionRow>(`${SESSION_SELECT} where s.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The session the person has open, if any. */
export async function openSessionOf(
  client: pg.ClientBase,
  userId: string,
): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionRow>(
    `${SESSION_SELECT} where s.opened_by = $1 and s.closed_at is null`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function listSessions(
  client: pg.ClientBase,
  options: { cursor?: string; limit: number },
): Promise<Page<SessionRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'sessions') : undefined;
  if (after === null) return null;
  const { rows } = await client.query<SessionRow>(
    `${SESSION_SELECT}
     where ($1::timestamptz is null or (s.opened_at, s.id) < ($1::timestamptz, $2::uuid))
     order by s.opened_at desc, s.id desc
     limit $3`,
    [after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > options.limit && last ? encodeCursor('sessions', last.at_exact, last.id) : null,
    ...(after === undefined ? { total: rows[0]?.total ?? 0 } : {}),
  };
}

export async function insertSession(
  client: pg.ClientBase,
  session: { id: string; by: string; openingMinor: number },
): Promise<void> {
  await client.query(
    `insert into cash_register_sessions (id, tenant_id, opened_by, opening_minor)
     values ($1, app_tenant_id(), $2, $3)`,
    [session.id, session.by, session.openingMinor],
  );
}

/** Holds the session against payments recorded into it while it is settled. */
export async function lockSession(client: pg.ClientBase, id: string): Promise<boolean> {
  const { rows } = await client.query<{ open: boolean }>(
    'select closed_at is null as open from cash_register_sessions where id = $1 for update',
    [id],
  );
  return rows[0]?.open ?? false;
}

export async function closeSession(
  client: pg.ClientBase,
  session: {
    id: string;
    by: string;
    expectedMinor: number;
    countedMinor: number;
    note: string | null;
  },
): Promise<void> {
  await client.query(
    `update cash_register_sessions set closed_at = now(), closed_by = $2, expected_minor = $3,
       counted_minor = $4, note = $5
     where id = $1`,
    [session.id, session.by, session.expectedMinor, session.countedMinor, session.note],
  );
}
