import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  BillListQuery,
  CreditAccount,
  CreditAccountPage,
  CreditAccountWrite,
  CreditBill,
  CreditBillCreate,
  CreditBillPage,
  CreditPayerParams,
  CreditStatement,
  PageQuery,
  Receipt,
  ReceiptCreate,
  ReceiptPage,
  StatementQuery,
} from './credit-schemas.js';
import { EncounterParams } from './schemas.js';
import { visitPatient } from './split.js';
import { isCode, isUuid, requirePatient, tidy, userIdOf } from './util.js';

const FEATURE = 'insurance';

const billNumber = (seq: number) => `CB-${String(seq).padStart(6, '0')}`;
const receiptNumber = (seq: number) => `RC-${String(seq).padStart(6, '0')}`;
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}
const wholeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
};

/** Adding days to a calendar date is done by the database, which knows the calendar. */
const addDays = async (client: pg.ClientBase, day: string, days: number): Promise<string> =>
  (await client.query<{ d: string }>(`select ($1::date + $2::int)::text as d`, [day, days])).rows[0]
    ?.d as string;

const payerGone = () => new HttpError(404, 'payer_not_found', 'No such organisation');
const accountGone = () => new HttpError(404, 'credit_account_not_found', 'No credit account');

/** The 404 for a payer with no account: no such organisation, or an organisation with none. */
async function missing(client: pg.ClientBase, payerId: string): Promise<HttpError> {
  if (isUuid(payerId)) {
    const found = await client.query('select 1 from payers where id = $1', [payerId]);
    if (found.rows.length > 0) return accountGone();
  }
  return payerGone();
}

// --- accounts ----------------------------------------------------------------------------------

interface AccountRow {
  payer_id: string;
  payer_name: string;
  credit_limit_minor: string;
  terms_days: number;
  version: number;
  billed: string;
  received: string;
  overdue: string;
}

/** $1 is today at the hospital. */
const ACCOUNTS = `select a.payer_id, py.name as payer_name, a.credit_limit_minor, a.terms_days,
       a.version, coalesce(sum(b.amount_minor), 0) as billed,
       coalesce(sum(b.received_minor), 0) as received,
       coalesce(sum(b.amount_minor - b.received_minor) filter (where b.due_on < $1::date), 0)
         as overdue
  from credit_accounts a
  join payers py on py.tenant_id = a.tenant_id and py.id = a.payer_id
  left join credit_bills b on b.tenant_id = a.tenant_id and b.payer_id = a.payer_id`;
const ACCOUNT_GROUP = 'group by a.payer_id, py.name, a.credit_limit_minor, a.terms_days, a.version';

function accountView(row: AccountRow): CreditAccount {
  const billed = Number(row.billed);
  const received = Number(row.received);
  const limit = Number(row.credit_limit_minor);
  return {
    payerId: row.payer_id,
    payerName: row.payer_name,
    creditLimitMinor: limit,
    termsDays: row.terms_days,
    billedMinor: billed,
    receivedMinor: received,
    outstandingMinor: billed - received,
    overdueMinor: Number(row.overdue),
    availableMinor: Math.max(limit - (billed - received), 0),
    version: row.version,
  };
}

async function accountOf(client: pg.ClientBase, payerId: string): Promise<AccountRow | undefined> {
  if (!isUuid(payerId)) return undefined;
  const today = await todayAtHospital(client);
  return (
    await client.query<AccountRow>(`${ACCOUNTS} where a.payer_id = $2 ${ACCOUNT_GROUP}`, [
      today,
      payerId,
    ])
  ).rows[0];
}

/** The account locked for the transaction, so limit and allocation checks cannot interleave. */
async function lockedAccount(client: pg.ClientBase, payerId: string) {
  if (!isUuid(payerId)) throw payerGone();
  const account = (
    await client.query<{ credit_limit_minor: string; terms_days: number }>(
      'select credit_limit_minor, terms_days from credit_accounts where payer_id = $1 for update',
      [payerId],
    )
  ).rows[0];
  if (!account) throw await missing(client, payerId);
  return { limit: Number(account.credit_limit_minor), termsDays: account.terms_days };
}

async function outstandingOf(client: pg.ClientBase, payerId: string): Promise<number> {
  const row = (
    await client.query<{ owed: string }>(
      `select coalesce(sum(amount_minor - received_minor), 0) as owed
         from credit_bills where payer_id = $1`,
      [payerId],
    )
  ).rows[0];
  return Number(row?.owed ?? 0);
}

async function nextNumber(client: pg.ClientBase, kind: 'bill' | 'receipt'): Promise<number> {
  const row = (
    await client.query<{ last_number: number }>(
      `insert into credit_counters (kind, last_number) values ($1, 1)
       on conflict (tenant_id, kind) do update set last_number = credit_counters.last_number + 1
       returning last_number`,
      [kind],
    )
  ).rows[0];
  return row?.last_number as number;
}

// --- bills -------------------------------------------------------------------------------------

interface BillRow {
  id: string;
  seq: number;
  payer_id: string;
  payer_name: string;
  encounter_id: string;
  issued_on: string;
  due_on: string;
  amount_minor: string;
  received_minor: string;
  overdue: boolean;
}

/** $1 is today at the hospital. */
const BILLS = `select b.id, b.seq, b.payer_id, py.name as payer_name, b.encounter_id,
       b.issued_on::text as issued_on, b.due_on::text as due_on, b.amount_minor, b.received_minor,
       (b.due_on < $1::date and b.received_minor < b.amount_minor) as overdue
  from credit_bills b
  join payers py on py.tenant_id = b.tenant_id and py.id = b.payer_id`;

function billView(row: BillRow): CreditBill {
  const amount = Number(row.amount_minor);
  const received = Number(row.received_minor);
  return {
    id: row.id,
    number: billNumber(row.seq),
    payerId: row.payer_id,
    payerName: row.payer_name,
    encounterId: row.encounter_id,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    amountMinor: amount,
    receivedMinor: received,
    outstandingMinor: amount - received,
    status: received === 0 ? 'open' : received >= amount ? 'paid' : 'part_paid',
    overdue: row.overdue,
  };
}

// --- receipts ----------------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  seq: number;
  payer_id: string;
  payer_name: string;
  received_on: string;
  method: Receipt['method'];
  reference: string | null;
  amount_minor: string;
}

const RECEIPTS = `select r.id, r.seq, r.payer_id, py.name as payer_name,
       r.received_on::text as received_on, r.method, r.reference, r.amount_minor
  from credit_receipts r
  join payers py on py.tenant_id = r.tenant_id and py.id = r.payer_id`;

async function receiptViews(client: pg.ClientBase, rows: ReceiptRow[]): Promise<Receipt[]> {
  const ids = rows.map((row) => row.id);
  const allocations = ids.length
    ? (
        await client.query<{
          receipt_id: string;
          bill_id: string;
          seq: number;
          amount_minor: string;
        }>(
          `select a.receipt_id, a.bill_id, b.seq, a.amount_minor
             from credit_receipt_allocations a
             join credit_bills b on b.tenant_id = a.tenant_id and b.id = a.bill_id
            where a.receipt_id = any($1::uuid[]) order by b.issued_on, b.seq`,
          [ids],
        )
      ).rows
    : [];
  return rows.map((row) => ({
    id: row.id,
    number: receiptNumber(row.seq),
    payerId: row.payer_id,
    payerName: row.payer_name,
    receivedOn: row.received_on,
    method: row.method,
    ...(row.reference === null ? {} : { reference: row.reference }),
    amountMinor: Number(row.amount_minor),
    allocations: allocations
      .filter((alloc) => alloc.receipt_id === row.id)
      .map((alloc) => ({
        billId: alloc.bill_id,
        billNumber: billNumber(alloc.seq),
        amountMinor: Number(alloc.amount_minor),
      })),
  }));
}

export const creditRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/credit-accounts',
    {
      config: { permissions: ['receivable:read'], feature: FEATURE },
      schema: {
        operationId: 'listCreditAccounts',
        tags: ['insurance'],
        description:
          'Corporate credit accounts with what is billed, received and still owed, largest balance first, one cursor page. Needs receivable:read.',
        querystring: PageQuery,
        response: { 200: ref(CreditAccountPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const params: unknown[] = [await todayAtHospital(client)];
      let after = '';
      if (request.query.cursor) {
        const cursor = decode(request.query.cursor);
        if (typeof cursor.p !== 'string' || !isUuid(cursor.p)) {
          throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
        }
        params.push(wholeNumber(cursor.o), cursor.p);
        after = 'where (x.owed, x.payer_id) < ($2::bigint, $3::uuid)';
      }
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await client.query<AccountRow & { owed: string }>(
        `select * from (select s.*, (s.billed - s.received) as owed
                          from (${ACCOUNTS} ${ACCOUNT_GROUP}) s) x
          ${after} order by x.owed desc, x.payer_id desc limit $${params.length}`,
        params,
      );
      const total = (
        await client.query<{ n: number }>('select count(*)::int as n from credit_accounts')
      ).rows[0]?.n;
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'credit_account', row.payer_id);
      const last = page[page.length - 1];
      return {
        items: page.map(accountView),
        nextCursor:
          rows.length > limit && last ? encode({ o: Number(last.owed), p: last.payer_id }) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.get(
    '/payers/:payerId/credit-account',
    {
      config: { permissions: ['receivable:read'], feature: FEATURE },
      schema: {
        operationId: 'getCreditAccount',
        tags: ['insurance'],
        description:
          'The credit account of a corporate. 404 when it has none. Needs receivable:read.',
        params: CreditPayerParams,
        response: { 200: ref(CreditAccount), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await accountOf(request.txClient, request.params.payerId);
      if (!row) throw await missing(request.txClient, request.params.payerId);
      request.audit('read', 'credit_account', row.payer_id);
      return accountView(row);
    },
  );

  app.put(
    '/payers/:payerId/credit-account',
    {
      config: { permissions: ['receivable:manage'], feature: FEATURE },
      schema: {
        operationId: 'setCreditAccount',
        tags: ['insurance'],
        description:
          'Opens the credit account of a corporate or changes its limit and terms; a change carries the version it started from (409 `version_conflict`). Only a corporate has one (422 `not_corporate`). A limit below what is already owed is 422 `below_outstanding`. Needs receivable:manage. Audited.',
        params: CreditPayerParams,
        body: CreditAccountWrite,
        response: { 200: ref(CreditAccount), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const { payerId } = request.params;
      const payer = isUuid(payerId)
        ? (
            await client.query<{ kind: string; archived: boolean }>(
              'select kind, archived from payers where id = $1 for share',
              [payerId],
            )
          ).rows[0]
        : undefined;
      if (!payer) throw payerGone();
      if (payer.kind !== 'corporate') {
        throw new HttpError(422, 'not_corporate', 'Only a corporate has a credit account');
      }
      const body = request.body;
      const conflict = () =>
        new HttpError(409, 'version_conflict', 'The account was changed by someone else');
      const existing = (
        await client.query<{ version: number }>(
          'select version from credit_accounts where payer_id = $1 for update',
          [payerId],
        )
      ).rows[0];
      if (existing) {
        if (body.version !== existing.version) throw conflict();
        if (body.creditLimitMinor < (await outstandingOf(client, payerId))) {
          throw new HttpError(422, 'below_outstanding', 'The limit is below what is owed');
        }
        await client.query(
          'update credit_accounts set credit_limit_minor = $2, terms_days = $3 where payer_id = $1',
          [payerId, body.creditLimitMinor, body.termsDays],
        );
        request.audit('update', 'credit_account', payerId);
      } else {
        if (body.version !== undefined) throw conflict();
        if (payer.archived) {
          throw new HttpError(409, 'payer_archived', 'The organisation is archived');
        }
        try {
          await client.query(
            `insert into credit_accounts (payer_id, credit_limit_minor, terms_days, created_by)
             values ($1, $2, $3, $4)`,
            [payerId, body.creditLimitMinor, body.termsDays, userIdOf(request)],
          );
        } catch (error) {
          if (isCode(error, '23505')) throw conflict();
          throw error;
        }
        request.audit('create', 'credit_account', payerId);
      }
      return accountView((await accountOf(client, payerId)) as AccountRow);
    },
  );

  app.get(
    '/payers/:payerId/credit-bills',
    {
      config: { permissions: ['receivable:read'], feature: FEATURE },
      schema: {
        operationId: 'listCreditBills',
        tags: ['insurance'],
        description:
          'The bills put on a corporate account, oldest first, one cursor page. Needs receivable:read.',
        params: CreditPayerParams,
        querystring: BillListQuery,
        response: { 200: ref(CreditBillPage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const { payerId } = request.params;
      if (!(await accountOf(client, payerId))) throw await missing(client, payerId);
      const filters: string[] = [];
      const status = request.query.status;
      if (status === 'open') filters.push('b.received_minor = 0');
      if (status === 'part_paid') {
        filters.push('b.received_minor > 0 and b.received_minor < b.amount_minor');
      }
      if (status === 'paid') filters.push('b.received_minor >= b.amount_minor');
      const where = ['b.payer_id = $2', ...filters];
      const total = (
        await client.query<{ n: number }>(
          `select count(*)::int as n from credit_bills b where b.payer_id = $1
            ${filters.map((f) => 'and ' + f).join(' ')}`,
          [payerId],
        )
      ).rows[0]?.n;
      const params: unknown[] = [await todayAtHospital(client), payerId];
      if (request.query.cursor) {
        params.push(wholeNumber(decode(request.query.cursor).s));
        where.push(`b.seq > $${params.length}`);
      }
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await client.query<BillRow>(
        `${BILLS} where ${where.join(' and ')} order by b.seq limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'credit_bill', row.id);
      const last = page[page.length - 1];
      return {
        items: page.map(billView),
        nextCursor: rows.length > limit && last ? encode({ s: last.seq }) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/encounters/:encounterId/credit-bills',
    {
      config: {
        permissions: ['receivable:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createCreditBill',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Bills the whole of a visit to a corporate credit account: the visit charge ledger (void charges left out), due after the account terms. One credit bill per visit (409 `credit_bill_exists`); nothing to bill is 422 `nothing_to_bill`; over the limit is 422 `credit_limit_exceeded`. Needs receivable:manage. Audited.',
        params: EncounterParams,
        body: CreditBillCreate,
        response: { 201: ref(CreditBill), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const { encounterId } = request.params;
      const payerId = request.body.payerId;
      const patientId = await visitPatient(client, encounterId);
      await requirePatient(request, patientId);
      const account = await lockedAccount(client, payerId);
      const total = Number(
        (
          await client.query<{ total: string }>(
            `select coalesce(sum(total_minor), 0) as total from charges
              where encounter_id = $1 and status <> 'void'`,
            [encounterId],
          )
        ).rows[0]?.total ?? 0,
      );
      if (total <= 0) throw new HttpError(422, 'nothing_to_bill', 'The visit has nothing to bill');
      const exists = () =>
        new HttpError(409, 'credit_bill_exists', 'This visit is already on a credit bill');
      const taken = await client.query('select 1 from credit_bills where encounter_id = $1', [
        encounterId,
      ]);
      if (taken.rows.length > 0) throw exists();
      if ((await outstandingOf(client, payerId)) + total > account.limit) {
        throw new HttpError(422, 'credit_limit_exceeded', 'The bill is over the credit limit');
      }
      const today = await todayAtHospital(client);
      const due = await addDays(client, today, account.termsDays);
      const seq = await nextNumber(client, 'bill');
      let id: string;
      try {
        id = (
          await client.query<{ id: string }>(
            `insert into credit_bills (seq, payer_id, encounter_id, issued_on, due_on, amount_minor,
               created_by)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [seq, payerId, encounterId, today, due, total, userIdOf(request)],
          )
        ).rows[0]?.id as string;
      } catch (error) {
        if (isCode(error, '23505', 'credit_bills_one_per_visit')) throw exists();
        throw error;
      }
      request.audit('create', 'credit_bill', id);
      const row = (await client.query<BillRow>(`${BILLS} where b.id = $2`, [today, id]))
        .rows[0] as BillRow;
      return reply.status(201).send(billView(row));
    },
  );

  app.get(
    '/payers/:payerId/receipts',
    {
      config: { permissions: ['receivable:read'], feature: FEATURE },
      schema: {
        operationId: 'listReceipts',
        tags: ['insurance'],
        description:
          'The money received from a corporate, newest first, one cursor page. Needs receivable:read.',
        params: CreditPayerParams,
        querystring: PageQuery,
        response: { 200: ref(ReceiptPage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const { payerId } = request.params;
      if (!(await accountOf(client, payerId))) throw await missing(client, payerId);
      const total = (
        await client.query<{ n: number }>(
          'select count(*)::int as n from credit_receipts where payer_id = $1',
          [payerId],
        )
      ).rows[0]?.n;
      const params: unknown[] = [payerId];
      let after = '';
      if (request.query.cursor) {
        params.push(wholeNumber(decode(request.query.cursor).s));
        after = 'and r.seq < $2';
      }
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await client.query<ReceiptRow>(
        `${RECEIPTS} where r.payer_id = $1 ${after} order by r.seq desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'credit_receipt', row.id);
      const last = page[page.length - 1];
      return {
        items: await receiptViews(client, page),
        nextCursor: rows.length > limit && last ? encode({ s: last.seq }) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/payers/:payerId/receipts',
    {
      config: {
        permissions: ['receivable:receipt'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'recordReceipt',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records money received from a corporate and sets it against its oldest unpaid bills first, in one transaction. More than is owed is 422 `exceeds_outstanding`; a date in the future is 422 `future_date`; a date before the bill it pays is 422 `before_bill`. Needs receivable:receipt. Audited.',
        params: CreditPayerParams,
        body: ReceiptCreate,
        response: { 201: ref(Receipt), ...errors(400, 401, 403, 404, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const { payerId } = request.params;
      const body = request.body;
      await lockedAccount(client, payerId);
      const today = await todayAtHospital(client);
      if (body.receivedOn > today) {
        throw new HttpError(422, 'future_date', 'Money cannot be received in the future');
      }
      const bills = (
        await client.query<{ id: string; owed: string; issued_on: string }>(
          `select id, (amount_minor - received_minor) as owed, issued_on::text as issued_on
             from credit_bills where payer_id = $1 and received_minor < amount_minor
            order by issued_on, seq for update`,
          [payerId],
        )
      ).rows;
      const owed = bills.reduce((sum, bill) => sum + Number(bill.owed), 0);
      if (body.amountMinor > owed) {
        throw new HttpError(422, 'exceeds_outstanding', 'More than is owed on the account');
      }
      let left = body.amountMinor;
      const applied: { id: string; amount: number }[] = [];
      for (const bill of bills) {
        if (left === 0) break;
        if (body.receivedOn < bill.issued_on) {
          throw new HttpError(422, 'before_bill', 'The money is dated before the bill it pays');
        }
        const amount = Math.min(left, Number(bill.owed));
        applied.push({ id: bill.id, amount });
        left -= amount;
      }
      const seq = await nextNumber(client, 'receipt');
      const id = (
        await client.query<{ id: string }>(
          `insert into credit_receipts (seq, payer_id, received_on, method, reference, amount_minor,
             created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            seq,
            payerId,
            body.receivedOn,
            body.method,
            body.reference === undefined ? null : tidy(body.reference),
            body.amountMinor,
            userIdOf(request),
          ],
        )
      ).rows[0]?.id as string;
      for (const part of applied) {
        await client.query(
          'update credit_bills set received_minor = received_minor + $2 where id = $1',
          [part.id, part.amount],
        );
        await client.query(
          `insert into credit_receipt_allocations (receipt_id, bill_id, amount_minor)
           values ($1, $2, $3)`,
          [id, part.id, part.amount],
        );
      }
      request.audit('create', 'credit_receipt', id);
      const row = (await client.query<ReceiptRow>(`${RECEIPTS} where r.id = $1`, [id]))
        .rows[0] as ReceiptRow;
      return reply.status(201).send((await receiptViews(client, [row]))[0] as Receipt);
    },
  );

  app.get(
    '/payers/:payerId/credit-statement',
    {
      config: { permissions: ['receivable:read'], feature: FEATURE },
      schema: {
        operationId: 'getCreditStatement',
        tags: ['insurance'],
        description:
          'The statement of an account for a period: the balance before it, every bill and receipt in date order (a bill before a receipt of the same day) with the running balance, and the balance at the end, one cursor page of lines. The totals cover the whole period. A period that ends before it starts is 422 `invalid_period`. Needs receivable:read.',
        params: CreditPayerParams,
        querystring: StatementQuery,
        response: { 200: ref(CreditStatement), ...errors(400, 401, 403, 404, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const { payerId } = request.params;
      const { from, to } = request.query;
      const account = await accountOf(client, payerId);
      if (!account) throw await missing(client, payerId);
      if (to < from) throw new HttpError(422, 'invalid_period', 'The period ends before it starts');
      const sums = (
        await client.query<{ opening: string; billed: string; received: string }>(
          `select
             (coalesce((select sum(amount_minor) from credit_bills
                         where payer_id = $1 and issued_on < $2::date), 0)
              - coalesce((select sum(amount_minor) from credit_receipts
                           where payer_id = $1 and received_on < $2::date), 0)) as opening,
             coalesce((select sum(amount_minor) from credit_bills
                        where payer_id = $1 and issued_on between $2::date and $3::date), 0)
               as billed,
             coalesce((select sum(amount_minor) from credit_receipts
                        where payer_id = $1 and received_on between $2::date and $3::date), 0)
               as received`,
          [payerId, from, to],
        )
      ).rows[0] as { opening: string; billed: string; received: string };
      const opening = Number(sums.opening);
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const after = request.query.cursor ? wholeNumber(decode(request.query.cursor).n) : 0;
      const { rows } = await client.query<{
        id: string;
        rn: string;
        on_date: string;
        kind: 'bill' | 'receipt';
        seq: number;
        debit: string;
        credit: string;
        balance: string;
      }>(
        `with lines as (
           select id, issued_on as on_date, 0 as ord, seq, 'bill' as kind,
                  amount_minor as debit, 0::bigint as credit
             from credit_bills where payer_id = $1 and issued_on between $2::date and $3::date
           union all
           select id, received_on, 1, seq, 'receipt', 0::bigint, amount_minor
             from credit_receipts where payer_id = $1 and received_on between $2::date and $3::date
         ), run as (
           select l.*, row_number() over w as rn,
                  $4::bigint + sum(debit - credit) over w as balance
             from lines l window w as (order by on_date, ord, seq)
         )
         select id, rn, on_date::text as on_date, kind, seq, debit, credit, balance
           from run where rn > $5 order by rn limit $6`,
        [payerId, from, to, opening, after, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const billed = Number(sums.billed);
      const received = Number(sums.received);
      request.audit('read', 'credit_statement', payerId);
      return {
        payerId,
        payerName: account.payer_name,
        from,
        to,
        openingMinor: opening,
        billedMinor: billed,
        receivedMinor: received,
        closingMinor: opening + billed - received,
        items: page.map((row) => ({
          id: row.id,
          on: row.on_date,
          kind: row.kind,
          number: row.kind === 'bill' ? billNumber(row.seq) : receiptNumber(row.seq),
          debitMinor: Number(row.debit),
          creditMinor: Number(row.credit),
          balanceMinor: Number(row.balance),
        })),
        nextCursor: rows.length > limit && last ? encode({ n: Number(last.rn) }) : null,
      };
    },
  );
};
