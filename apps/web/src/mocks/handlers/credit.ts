import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockCharges } from './billing';
import { mockEncounter } from './clinical';
import { mockPayer } from './insurance';

type Schemas = components['schemas'];
type Account = Schemas['CreditAccount'];
type Bill = Schemas['CreditBill'];
type Receipt = Schemas['Receipt'];
type Line = Schemas['StatementLine'];

const FEATURE_FLAG = 'insurance';
const DAY_MS = 86_400_000;
const METHODS = ['cash', 'bank_transfer', 'cheque', 'card'];
const PLAIN = /^[^<>]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface StoredAccount {
  tenantId: string;
  payerId: string;
  creditLimitMinor: number;
  termsDays: number;
  version: number;
}
interface StoredBill extends Omit<Bill, 'payerName' | 'outstandingMinor' | 'status' | 'overdue'> {
  tenantId: string;
}
interface StoredReceipt extends Receipt {
  tenantId: string;
}
interface State {
  accounts: StoredAccount[];
  bills: StoredBill[];
  receipts: StoredReceipt[];
  billCount: number;
  receiptCount: number;
  replies: Map<string, string>;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (days: number) => dayOf(Date.now() - days * DAY_MS);
const today = () => dayOf(Date.now());
const addDays = (day: string, days: number) => dayOf(Date.parse(day) + days * DAY_MS);

/**
 * Acme Industries (a corporate of the sample hospital) has a credit account with two bills, one
 * past its due date, and a receipt that settled part of the older one. The clinic has none, which
 * shows that nothing crosses between hospitals.
 */
function seed(): State {
  const H = TENANT_IDS.hospital;
  const bill = (
    n: number,
    ago: number,
    amountMinor: number,
    receivedMinor: number,
  ): StoredBill => ({
    id: `crb_h_${n}`,
    tenantId: H,
    number: `CB-${String(n).padStart(6, '0')}`,
    payerId: 'pyr_h_acme',
    encounterId: `enc_seed_${n}`,
    issuedOn: daysAgo(ago),
    dueOn: addDays(daysAgo(ago), 30),
    amountMinor,
    receivedMinor,
  });
  return {
    accounts: [
      {
        tenantId: H,
        payerId: 'pyr_h_acme',
        creditLimitMinor: 5_000_000,
        termsDays: 30,
        version: 1,
      },
    ],
    bills: [bill(1, 55, 1_200_000, 500_000), bill(2, 10, 800_000, 0)],
    receipts: [
      {
        id: 'rct_h_1',
        tenantId: H,
        number: 'RC-000001',
        payerId: 'pyr_h_acme',
        payerName: 'Acme Industries',
        receivedOn: daysAgo(20),
        method: 'bank_transfer',
        reference: 'NEFT-4471',
        amountMinor: 500_000,
        allocations: [{ billId: 'crb_h_1', billNumber: 'CB-000001', amountMinor: 500_000 }],
      },
    ],
    billCount: 2,
    receiptCount: 1,
    replies: new Map(),
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

const outstandingOf = (bill: StoredBill) => bill.amountMinor - bill.receivedMinor;

function billView(bill: StoredBill): Bill {
  const { tenantId: _tenant, ...rest } = bill;
  void _tenant;
  const outstandingMinor = outstandingOf(bill);
  return {
    ...rest,
    payerName: mockPayer(bill.tenantId, bill.payerId)?.name ?? '',
    outstandingMinor,
    status: outstandingMinor === 0 ? 'paid' : bill.receivedMinor > 0 ? 'part_paid' : 'open',
    overdue: outstandingMinor > 0 && bill.dueOn < today(),
  };
}

function accountView(account: StoredAccount): Account {
  const bills = state.bills.filter(
    (one) => one.tenantId === account.tenantId && one.payerId === account.payerId,
  );
  const billedMinor = bills.reduce((sum, one) => sum + one.amountMinor, 0);
  const receivedMinor = bills.reduce((sum, one) => sum + one.receivedMinor, 0);
  const outstandingMinor = billedMinor - receivedMinor;
  const overdueMinor = bills
    .filter((one) => outstandingOf(one) > 0 && one.dueOn < today())
    .reduce((sum, one) => sum + outstandingOf(one), 0);
  return {
    payerId: account.payerId,
    payerName: mockPayer(account.tenantId, account.payerId)?.name ?? '',
    creditLimitMinor: account.creditLimitMinor,
    termsDays: account.termsDays,
    billedMinor,
    receivedMinor,
    outstandingMinor,
    overdueMinor,
    availableMinor: Math.max(account.creditLimitMinor - outstandingMinor, 0),
    version: account.version,
  };
}

const accountOf = (tenantId: string, payerId: string) =>
  state.accounts.find((one) => one.tenantId === tenantId && one.payerId === payerId);

type Body = Record<string, unknown>;
async function readBody(request: Request): Promise<Body | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Body)
      : undefined;
  } catch {
    return undefined;
  }
}
const bad = () => error(400, 'validation_failed', 'The request is not valid');
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function paged<T extends { id: string }>(rows: T[], url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
  const cursor = url.searchParams.get('cursor');
  const start = cursor ? rows.findIndex((one) => one.id === cursor) : 0;
  if (start < 0) return undefined;
  return {
    items: rows.slice(start, start + limit),
    nextCursor: start + limit < rows.length ? (rows[start + limit]?.id ?? null) : null,
    total: rows.length,
  };
}

export const creditHandlers = [
  http.get('*/api/credit-accounts', ({ request }) => {
    const access = authorize(request, { permission: 'receivable:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const rows = state.accounts
      .filter((one) => one.tenantId === access.tenantId)
      .map((one) => ({ ...accountView(one), id: one.payerId }))
      .sort((a, b) => b.outstandingMinor - a.outstandingMinor);
    const page = paged(rows, new URL(request.url));
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      ...page,
      items: page.items.map(({ id: _id, ...account }) => {
        void _id;
        return account;
      }),
    });
  }),

  http.get('*/api/payers/:payerId/credit-account', ({ request, params }) => {
    const access = authorize(request, { permission: 'receivable:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const found = accountOf(access.tenantId, String(params.payerId));
    if (!found) return error(404, 'not_found', 'No credit account');
    return HttpResponse.json(accountView(found));
  }),

  http.put('*/api/payers/:payerId/credit-account', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'receivable:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (
      !body ||
      !isInt(body.creditLimitMinor, 0, 2_000_000_000) ||
      !isInt(body.termsDays, 0, 365) ||
      (body.version !== undefined && !isInt(body.version, 1, 1_000_000))
    ) {
      return bad();
    }
    const payerId = String(params.payerId);
    const payer = mockPayer(access.tenantId, payerId);
    if (!payer) return error(404, 'not_found', 'No such organisation');
    if (payer.kind !== 'corporate') {
      return error(422, 'not_corporate', 'Only a corporate has a credit account');
    }
    const found = accountOf(access.tenantId, payerId);
    if (found) {
      if (body.version !== found.version) {
        return error(409, 'version_conflict', 'The account was changed by someone else');
      }
      if (body.creditLimitMinor < accountView(found).outstandingMinor) {
        return error(422, 'below_outstanding', 'The limit is below what is owed');
      }
      found.creditLimitMinor = body.creditLimitMinor;
      found.termsDays = body.termsDays;
      found.version += 1;
      return HttpResponse.json(accountView(found));
    }
    const made: StoredAccount = {
      tenantId: access.tenantId,
      payerId,
      creditLimitMinor: body.creditLimitMinor,
      termsDays: body.termsDays,
      version: 1,
    };
    state.accounts.push(made);
    return HttpResponse.json(accountView(made));
  }),

  http.get('*/api/payers/:payerId/credit-bills', ({ request, params }) => {
    const access = authorize(request, { permission: 'receivable:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const payerId = String(params.payerId);
    if (!accountOf(access.tenantId, payerId)) return error(404, 'not_found', 'No credit account');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status !== null && !['open', 'part_paid', 'paid'].includes(status)) return bad();
    const rows = state.bills
      .filter((one) => one.tenantId === access.tenantId && one.payerId === payerId)
      .map(billView)
      .filter((one) => !status || one.status === status);
    const page = paged(rows, url);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json(page);
  }),

  http.get('*/api/payers/:payerId/receipts', ({ request, params }) => {
    const access = authorize(request, { permission: 'receivable:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const payerId = String(params.payerId);
    if (!accountOf(access.tenantId, payerId)) return error(404, 'not_found', 'No credit account');
    const rows = state.receipts
      .filter((one) => one.tenantId === access.tenantId && one.payerId === payerId)
      .map(({ tenantId: _tenant, ...receipt }) => {
        void _tenant;
        return receipt;
      })
      .reverse();
    const page = paged(rows, new URL(request.url));
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json(page);
  }),

  http.get('*/api/payers/:payerId/credit-statement', ({ request, params }) => {
    const access = authorize(request, { permission: 'receivable:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const payerId = String(params.payerId);
    const account = accountOf(access.tenantId, payerId);
    if (!account) return error(404, 'not_found', 'No credit account');
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!DATE.test(from) || !DATE.test(to) || from > to) return bad();

    // Every bill and receipt of the account in date order, bills before receipts on one day.
    const all: (Omit<Line, 'balanceMinor'> & { order: number })[] = [
      ...state.bills
        .filter((one) => one.tenantId === access.tenantId && one.payerId === payerId)
        .map((one) => ({
          id: one.id,
          on: one.issuedOn,
          kind: 'bill' as const,
          number: one.number,
          debitMinor: one.amountMinor,
          creditMinor: 0,
          order: 0,
        })),
      ...state.receipts
        .filter((one) => one.tenantId === access.tenantId && one.payerId === payerId)
        .map((one) => ({
          id: one.id,
          on: one.receivedOn,
          kind: 'receipt' as const,
          number: one.number,
          debitMinor: 0,
          creditMinor: one.amountMinor,
          order: 1,
        })),
    ].sort((a, b) => a.on.localeCompare(b.on) || a.order - b.order);

    let balance = 0;
    let openingMinor = 0;
    let billedMinor = 0;
    let receivedMinor = 0;
    const lines: Line[] = [];
    for (const one of all) {
      if (one.on > to) break;
      balance += one.debitMinor - one.creditMinor;
      if (one.on < from) {
        openingMinor = balance;
        continue;
      }
      billedMinor += one.debitMinor;
      receivedMinor += one.creditMinor;
      const { order: _order, ...line } = one;
      void _order;
      lines.push({ ...line, balanceMinor: balance });
    }
    const page = paged(lines, url);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      payerId,
      payerName: mockPayer(access.tenantId, payerId)?.name ?? '',
      from,
      to,
      openingMinor,
      billedMinor,
      receivedMinor,
      closingMinor: balance,
      items: page.items,
      nextCursor: page.nextCursor,
    });
  }),

  http.post('*/api/payers/:payerId/receipts', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'receivable:receipt',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body = await readBody(request);
    if (
      !body ||
      !isInt(body.amountMinor, 1, 2_000_000_000) ||
      typeof body.method !== 'string' ||
      !METHODS.includes(body.method) ||
      typeof body.receivedOn !== 'string' ||
      !DATE.test(body.receivedOn) ||
      (body.reference !== undefined &&
        (typeof body.reference !== 'string' ||
          body.reference.length > 60 ||
          !PLAIN.test(body.reference)))
    ) {
      return bad();
    }
    const payerId = String(params.payerId);
    const account = accountOf(access.tenantId, payerId);
    if (!account) return error(404, 'not_found', 'No credit account');
    const replyKey = `${access.tenantId}:${key}`;
    const replied = state.replies.get(replyKey);
    const earlier = replied ? state.receipts.find((one) => one.id === replied) : undefined;
    if (earlier) {
      const { tenantId: _tenant, ...receipt } = earlier;
      void _tenant;
      return HttpResponse.json(receipt, { status: 201 });
    }
    if (body.receivedOn > today()) return bad();
    if (body.amountMinor > accountView(account).outstandingMinor) {
      return error(422, 'exceeds_outstanding', 'More than is owed');
    }
    // Oldest unpaid bill first.
    let left = body.amountMinor;
    const allocations: Receipt['allocations'] = [];
    const unpaid = state.bills
      .filter((one) => one.tenantId === access.tenantId && one.payerId === payerId)
      .filter((one) => outstandingOf(one) > 0)
      .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.id.localeCompare(b.id));
    for (const bill of unpaid) {
      if (left === 0) break;
      const take = Math.min(left, outstandingOf(bill));
      bill.receivedMinor += take;
      left -= take;
      allocations.push({ billId: bill.id, billNumber: bill.number, amountMinor: take });
    }
    state.receiptCount += 1;
    const made: StoredReceipt = {
      id: `rct_mock_${state.receiptCount}`,
      tenantId: access.tenantId,
      number: `RC-${String(state.receiptCount).padStart(6, '0')}`,
      payerId,
      payerName: mockPayer(access.tenantId, payerId)?.name ?? '',
      receivedOn: body.receivedOn,
      method: body.method as Receipt['method'],
      ...(typeof body.reference === 'string' && body.reference.trim()
        ? { reference: body.reference.trim() }
        : {}),
      amountMinor: body.amountMinor,
      allocations,
    };
    state.receipts.push(made);
    state.replies.set(replyKey, made.id);
    const { tenantId: _tenant, ...receipt } = made;
    void _tenant;
    return HttpResponse.json(receipt, { status: 201 });
  }),

  http.post('*/api/encounters/:encounterId/credit-bills', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'receivable:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const key = request.headers.get('Idempotency-Key');
    if (!key) return error(400, 'validation_failed', 'Idempotency-Key is required');
    const body = await readBody(request);
    if (!body || typeof body.payerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.payerId)) {
      return bad();
    }
    const encounterId = String(params.encounterId);
    const visit = mockEncounter(encounterId);
    if (!visit || visit.tenantId !== access.tenantId)
      return error(404, 'not_found', 'No such visit');
    const account = accountOf(access.tenantId, body.payerId);
    if (!account) return error(404, 'not_found', 'No credit account');
    const replyKey = `${access.tenantId}:${key}`;
    const replied = state.replies.get(replyKey);
    const earlier = replied ? state.bills.find((one) => one.id === replied) : undefined;
    if (earlier) return HttpResponse.json(billView(earlier), { status: 201 });
    if (
      state.bills.some((one) => one.tenantId === access.tenantId && one.encounterId === encounterId)
    ) {
      return error(409, 'credit_bill_exists', 'This visit is already billed to credit');
    }
    const amountMinor = mockCharges()
      .filter(
        (one) =>
          one.tenantId === access.tenantId &&
          one.encounterId === encounterId &&
          one.status !== 'void',
      )
      .reduce((sum, one) => sum + one.totalMinor, 0);
    if (amountMinor <= 0) return error(422, 'nothing_to_bill', 'The visit has nothing to bill');
    if (amountMinor > accountView(account).availableMinor) {
      return error(422, 'credit_limit_exceeded', 'The bill is more than the credit left');
    }
    state.billCount += 1;
    const made: StoredBill = {
      id: `crb_mock_${state.billCount}`,
      tenantId: access.tenantId,
      number: `CB-${String(state.billCount).padStart(6, '0')}`,
      payerId: body.payerId,
      encounterId,
      issuedOn: today(),
      dueOn: addDays(today(), account.termsDays),
      amountMinor,
      receivedMinor: 0,
    };
    state.bills.push(made);
    state.replies.set(replyKey, made.id);
    return HttpResponse.json(billView(made), { status: 201 });
  }),
];
