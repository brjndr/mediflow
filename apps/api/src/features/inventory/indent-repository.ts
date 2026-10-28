import type pg from 'pg';
import {
  decodeCursor,
  isUuid,
  ITEM_COLUMNS,
  paged,
  TODAY,
  type ItemColumns,
  type Page,
} from './repository.js';
import type { IndentStatus } from './schemas.js';

/**
 * The SQL of indents and issue vouchers (#105). Every statement runs on the request's own
 * transaction, so row-level security limits it to the active hospital. Stock itself moves through
 * `transferStock` (`stock-out.ts`), never here.
 */

/** The next number of a kind at the hospital, held until the transaction ends. */
export async function nextNumber(client: pg.ClientBase, kind: 'indent' | 'issue'): Promise<number> {
  const { rows } = await client.query<{ last_number: number }>(
    `insert into inventory_counters as c (tenant_id, kind, last_number)
     values (app_tenant_id(), $1, 1)
     on conflict (tenant_id, kind) do update set last_number = c.last_number + 1
     returning c.last_number`,
    [kind],
  );
  const number = rows[0]?.last_number;
  if (number === undefined) throw new Error('no number was given');
  return number;
}

export interface IndentRow {
  id: string;
  tenant_id: string;
  number: number;
  from_location_id: string;
  from_location_name: string;
  to_location_id: string;
  to_location_name: string;
  note: string | null;
  status: IndentStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: Date;
  /** The instant to the microsecond, for the cursor: a Date keeps milliseconds only. */
  requested_at_exact: string;
  decided_by_name: string | null;
  decided_at: Date | null;
  rejection_note: string | null;
  ended_by_name: string | null;
  ended_at: Date | null;
  end_note: string | null;
  line_count: number;
  version: number;
}

const INDENTS = `
  select i.id, i.tenant_id, i.number, i.from_location_id, fl.name as from_location_name,
    i.to_location_id, tl.name as to_location_name, i.note, i.status, i.requested_by,
    ru.name as requested_by_name, i.requested_at,
    to_char(i.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as requested_at_exact,
    du.name as decided_by_name, i.decided_at, i.rejection_note, eu.name as ended_by_name,
    i.ended_at, i.end_note,
    (select count(*)::int from stock_indent_lines n where n.tenant_id = i.tenant_id and n.indent_id = i.id)
      as line_count,
    i.version
  from stock_indents i
  join stock_locations fl on fl.tenant_id = i.tenant_id and fl.id = i.from_location_id
  join stock_locations tl on tl.tenant_id = i.tenant_id and tl.id = i.to_location_id
  left join users ru on ru.id = i.requested_by
  left join users du on du.id = i.decided_by
  left join users eu on eu.id = i.ended_by`;

/**
 * A page of the indents, newest asked first, of a status and of a place (asking or asked), or all.
 * Null: a bad cursor. Counted on the first page.
 */
export async function listIndents(
  client: pg.ClientBase,
  options: {
    status: IndentStatus | null;
    locationId: string | null;
    cursor?: string;
    limit: number;
  },
): Promise<Page<IndentRow> | null> {
  const after =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, ['instant', 'uuid']);
  if (after === null) return null;
  const filters = `($1::text is null or i.status = $1)
    and ($2::uuid is null or i.from_location_id = $2 or i.to_location_id = $2)`;
  const { rows } = await client.query<IndentRow>(
    `${INDENTS}
     where ${filters}
       and ($3::timestamptz is null or (i.requested_at, i.id) < ($3, $4::uuid))
     order by i.requested_at desc, i.id desc
     limit $5`,
    [options.status, options.locationId, after?.[0] ?? null, after?.[1] ?? null, options.limit + 1],
  );
  const result = paged(rows, options.limit, (row) => [row.requested_at_exact, row.id]);
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from stock_indents i where ${filters}`,
      [options.status, options.locationId],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export async function findIndent(client: pg.ClientBase, id: string): Promise<IndentRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<IndentRow>(`${INDENTS} where i.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The indent, held until the transaction ends, so two steps of it take their turn. */
export async function lockIndent(client: pg.ClientBase, id: string): Promise<IndentRow | null> {
  if (!isUuid(id)) return null;
  const locked = await client.query('select 1 from stock_indents where id = $1 for update', [id]);
  return locked.rowCount === 1 ? findIndent(client, id) : null;
}

export interface IndentLineRow extends ItemColumns {
  id: string;
  line_number: number;
  requested_quantity: number;
  approved_quantity: number | null;
  issued_quantity: number;
  store_on_hand: number;
}

/** The indent's lines in order, each with the item's stock at the store asked now. */
export async function indentLines(
  client: pg.ClientBase,
  indent: { id: string; to_location_id: string },
): Promise<IndentLineRow[]> {
  const { rows } = await client.query<IndentLineRow>(
    `select n.id, n.line_number, ${ITEM_COLUMNS}, n.requested_quantity, n.approved_quantity,
       n.issued_quantity,
       coalesce((select sum(b.on_hand) from stock_balances b
                 where b.tenant_id = n.tenant_id and b.drug_id = n.drug_id and b.location_id = $2), 0)::int
         as store_on_hand
     from stock_indent_lines n
     join drugs d on d.tenant_id = n.tenant_id and d.id = n.drug_id
     where n.indent_id = $1
     order by n.line_number`,
    [indent.id, indent.to_location_id],
  );
  return rows;
}

export interface IssueRow {
  id: string;
  number: number;
  note: string | null;
  issued_by_name: string | null;
  issued_at: Date;
}

export interface IssueLineRow {
  issue_id: string;
  indent_line_id: string;
  drug_id: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
}

/** The indent's vouchers, oldest first, with their lines. */
export async function indentIssues(
  client: pg.ClientBase,
  indentId: string,
): Promise<{ issues: IssueRow[]; lines: IssueLineRow[] }> {
  const issues = await client.query<IssueRow>(
    `select s.id, s.number, s.note, u.name as issued_by_name, s.issued_at
     from stock_issues s left join users u on u.id = s.issued_by
     where s.indent_id = $1
     order by s.issued_at, s.id`,
    [indentId],
  );
  const lines = await client.query<IssueLineRow>(
    `select l.issue_id, l.indent_line_id, l.drug_id, l.batch_id, t.batch_number,
       to_char(t.expiry_date, 'YYYY-MM-DD') as expiry_date, l.quantity
     from stock_issue_lines l
     join stock_batches t on t.tenant_id = l.tenant_id and t.id = l.batch_id
     join stock_indent_lines n on n.tenant_id = l.tenant_id and n.id = l.indent_line_id
     where l.indent_id = $1
     order by n.line_number, t.expiry_date, t.batch_key`,
    [indentId],
  );
  return { issues: issues.rows, lines: lines.rows };
}

export interface IssueBatchRow {
  drug_id: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  on_hand: number;
}

/** The batches of these items the store may issue: in date today, with stock there, nearest expiry first. */
export async function issueBatches(
  client: pg.ClientBase,
  drugIds: string[],
  locationId: string,
): Promise<IssueBatchRow[]> {
  if (drugIds.length === 0) return [];
  const { rows } = await client.query<IssueBatchRow>(
    `select b.drug_id, b.batch_id, t.batch_number, to_char(t.expiry_date, 'YYYY-MM-DD') as expiry_date,
       b.on_hand
     from stock_balances b
     join stock_batches t on t.tenant_id = b.tenant_id and t.id = b.batch_id
     where b.drug_id = any($1::uuid[]) and b.location_id = $2 and b.on_hand > 0
       and t.expiry_date >= ${TODAY}
     order by t.expiry_date, t.batch_key, b.batch_id`,
    [drugIds, locationId],
  );
  return rows;
}

export async function insertIndent(
  client: pg.ClientBase,
  indent: {
    number: number;
    fromLocationId: string;
    toLocationId: string;
    note: string | null;
    requestedBy: string;
    lines: { drugId: string; quantity: number }[];
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into stock_indents (tenant_id, number, from_location_id, to_location_id, note, requested_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5)
     returning id`,
    [indent.number, indent.fromLocationId, indent.toLocationId, indent.note, indent.requestedBy],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('indent was not created');
  await client.query(
    `insert into stock_indent_lines (tenant_id, indent_id, line_number, drug_id, requested_quantity)
     select app_tenant_id(), $1, line.ordinality, line.drug_id, line.quantity
     from unnest($2::uuid[], $3::int[]) with ordinality as line (drug_id, quantity, ordinality)`,
    [id, indent.lines.map((line) => line.drugId), indent.lines.map((line) => line.quantity)],
  );
  return id;
}

/** Sets what was approved of each line: called once, on approval. */
export async function approveLines(
  client: pg.ClientBase,
  indentId: string,
  lines: { lineId: string; quantity: number }[],
): Promise<void> {
  await client.query(
    `update stock_indent_lines n set approved_quantity = line.quantity
     from unnest($2::uuid[], $3::int[]) as line (id, quantity)
     where n.indent_id = $1 and n.id = line.id`,
    [indentId, lines.map((line) => line.lineId), lines.map((line) => line.quantity)],
  );
}

/** Moves the indent on: who decided or ended it and why, set once as its trigger holds. */
export async function moveIndent(
  client: pg.ClientBase,
  id: string,
  change:
    | { status: 'approved'; decidedBy: string }
    | { status: 'rejected'; decidedBy: string; note: string }
    | { status: 'cancelled'; endedBy: string }
    | { status: 'closed'; endedBy: string; note: string }
    | { status: 'partly_issued' | 'issued' },
): Promise<void> {
  if (change.status === 'approved' || change.status === 'rejected') {
    await client.query(
      `update stock_indents set status = $2, decided_by = $3, decided_at = now(), rejection_note = $4
       where id = $1`,
      [id, change.status, change.decidedBy, change.status === 'rejected' ? change.note : null],
    );
  } else if (change.status === 'cancelled' || change.status === 'closed') {
    await client.query(
      `update stock_indents set status = $2, ended_by = $3, ended_at = now(), end_note = $4
       where id = $1`,
      [id, change.status, change.endedBy, change.status === 'closed' ? change.note : null],
    );
  } else {
    await client.query('update stock_indents set status = $2 where id = $1 and status <> $2', [
      id,
      change.status,
    ]);
  }
}

export async function insertIssue(
  client: pg.ClientBase,
  issue: {
    number: number;
    indentId: string;
    fromLocationId: string;
    toLocationId: string;
    note: string | null;
    issuedBy: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into stock_issues (tenant_id, number, indent_id, from_location_id, to_location_id, note, issued_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [
      issue.number,
      issue.indentId,
      issue.fromLocationId,
      issue.toLocationId,
      issue.note,
      issue.issuedBy,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('issue was not created');
  return id;
}

export async function insertIssueLine(
  client: pg.ClientBase,
  line: {
    issueId: string;
    indentId: string;
    indentLineId: string;
    drugId: string;
    batchId: string;
    quantity: number;
    outEntryId: string;
    inEntryId: string;
  },
): Promise<void> {
  await client.query(
    `insert into stock_issue_lines (tenant_id, issue_id, indent_id, indent_line_id, drug_id, batch_id,
       quantity, out_entry_id, in_entry_id)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      line.issueId,
      line.indentId,
      line.indentLineId,
      line.drugId,
      line.batchId,
      line.quantity,
      line.outEntryId,
      line.inEntryId,
    ],
  );
}
