import type pg from 'pg';

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
  posted_at: Date;
  at_exact: string;
  total: number;
}

export async function listCharges(
  client: pg.ClientBase,
  options: { encounterId: string; status?: string; cursor?: string; limit: number },
): Promise<Page<ChargeRow> | null> {
  const after = options.cursor ? decodeCursor(options.cursor, 'charges') : undefined;
  if (after === null) return null;
  const { rows } = await client.query<ChargeRow>(
    `select c.id, c.tenant_id, c.encounter_id, c.source, c.description, c.quantity,
       c.unit_price_minor::text, c.total_minor::text, c.status, c.invoice_id, c.flag, c.posted_at,
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
  paid_minor: string;
  credited_minor: string;
  currency: string;
  version: number;
  created_at: Date;
  issued_at: Date | null;
  lines: {
    id: string;
    chargeId: string | null;
    source: string;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
  }[];
  at_exact: string;
  total: number;
}

const INVOICE_SELECT = `
  select i.id, i.tenant_id, i.encounter_id, i.patient_id,
    pt.first_name || ' ' || pt.last_name as patient_name, pt.mrn as patient_mrn,
    i.number, i.status, i.total_minor::text, i.paid_minor::text, i.credited_minor::text,
    i.currency, i.version, i.created_at, i.issued_at,
    coalesce((select json_agg(json_build_object('id', l.id, 'chargeId', l.charge_id,
        'source', l.source, 'description', l.description, 'quantity', l.quantity,
        'unitPriceMinor', l.unit_price_minor, 'totalMinor', l.total_minor)
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

export interface LockedInvoice {
  id: string;
  encounter_id: string;
  patient_id: string;
  status: string;
  total_minor: string;
  paid_minor: string;
  credited_minor: string;
  version: number;
}

/** Holds the invoice against every other change until the transaction ends. */
export async function lockInvoice(
  client: pg.ClientBase,
  id: string,
): Promise<LockedInvoice | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<LockedInvoice>(
    `select id, encounter_id, patient_id, status, total_minor::text, paid_minor::text,
       credited_minor::text, version
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
}

/** The lines a draft holds that were typed in, as they are now. */
export async function manualLinesOf(
  client: pg.ClientBase,
  invoiceId: string,
): Promise<ManualLineInput[]> {
  const { rows } = await client.query<{
    description: string;
    quantity: number;
    unit_price_minor: string;
  }>(
    `select description, quantity, unit_price_minor::text from invoice_lines
     where invoice_id = $1 and charge_id is null order by line_number`,
    [invoiceId],
  );
  return rows.map((row) => ({
    description: row.description,
    quantity: row.quantity,
    unitPriceMinor: num(row.unit_price_minor),
  }));
}

export interface HeldCharge {
  id: string;
  source: string;
  description: string;
  quantity: number;
  unit_price_minor: string;
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
    `select id, source, description, quantity, unit_price_minor::text, status, invoice_id
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

export async function replaceLines(
  client: pg.ClientBase,
  invoiceId: string,
  charges: HeldCharge[],
  manual: ManualLineInput[],
): Promise<number> {
  await client.query('delete from invoice_lines where invoice_id = $1', [invoiceId]);
  let number = 0;
  for (const charge of charges) {
    number += 1;
    await client.query(
      `insert into invoice_lines (tenant_id, invoice_id, line_number, charge_id, source,
         description, quantity, unit_price_minor)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        invoiceId,
        number,
        charge.id,
        charge.source,
        charge.description,
        charge.quantity,
        charge.unit_price_minor,
      ],
    );
  }
  for (const line of manual) {
    number += 1;
    await client.query(
      `insert into invoice_lines (tenant_id, invoice_id, line_number, source, description,
         quantity, unit_price_minor)
       values (app_tenant_id(), $1, $2, 'manual', $3, $4, $5)`,
      [invoiceId, number, line.description, line.quantity, line.unitPriceMinor],
    );
  }
  const { rows } = await client.query<{ total: string }>(
    'select coalesce(sum(total_minor), 0)::text as total from invoice_lines where invoice_id = $1',
    [invoiceId],
  );
  return num(rows[0]?.total);
}

export async function setDraftTotal(
  client: pg.ClientBase,
  invoiceId: string,
  totalMinor: number,
  bumpVersion: boolean,
): Promise<void> {
  await client.query('update invoices set total_minor = $2, version = version + $3 where id = $1', [
    invoiceId,
    totalMinor,
    bumpVersion ? 1 : 0,
  ]);
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

const SESSION_SELECT = `
  select s.id, s.opened_by, coalesce(u.name, '') as opened_by_name, s.opened_at,
    s.opening_minor::text, s.closed_at, s.counted_minor::text, s.note,
    coalesce(s.expected_minor, s.opening_minor + coalesce((select sum(case p.kind
       when 'payment' then p.amount_minor else -p.amount_minor end)
       from payments p where p.session_id = s.id), 0))::text as expected_minor,
    coalesce((select json_agg(json_build_object('method', t.method, 'paidMinor', t.paid,
        'refundedMinor', t.refunded) order by t.method)
      from (select p.method,
          coalesce(sum(p.amount_minor) filter (where p.kind = 'payment'), 0) as paid,
          coalesce(sum(p.amount_minor) filter (where p.kind = 'refund'), 0) as refunded
        from payments p where p.session_id = s.id group by p.method) t), '[]') as totals,
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
