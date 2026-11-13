import { z } from 'zod';
import { toMinor } from '@/features/services';
import { api, requireData } from '@/shared/api';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  CreditAccount,
  CreditAccountPage,
  CreditAccountWrite,
  CreditBillPage,
  CreditBillStatus,
  CreditStatement,
  Receipt,
  ReceiptCreate,
  ReceiptMethod,
  ReceiptPage,
} from './types';

// Corporate credit billing (IN-05, #185): a corporate has an account with a limit and payment
// terms, visits are billed to it, and money received is set against its oldest unpaid bills. The
// server owns every figure; the screens show them and check that they agree.

export const CREDIT_PAGE_SIZE = 25;
export const STATEMENT_PAGE_SIZE = 50;

export const RECEIPT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'card',
] as const satisfies readonly ReceiptMethod[];

export const BILL_STATUSES = [
  'open',
  'part_paid',
  'paid',
] as const satisfies readonly CreditBillStatus[];

const minor = z.number().int().min(0);
const date = z.string();
const accountSchema: z.ZodType<CreditAccount> = z.object({
  payerId: z.string(),
  payerName: z.string(),
  creditLimitMinor: minor,
  termsDays: z.number().int().min(0),
  billedMinor: minor,
  receivedMinor: minor,
  outstandingMinor: minor,
  overdueMinor: minor,
  availableMinor: minor,
  version: z.number().int().min(1),
});
const cursor = z.string().nullable();
const accountPageSchema: z.ZodType<CreditAccountPage> = z.object({
  items: z.array(accountSchema),
  nextCursor: cursor,
  total: z.number().int().min(0).optional(),
});
const billPageSchema: z.ZodType<CreditBillPage> = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      payerId: z.string(),
      payerName: z.string(),
      encounterId: z.string(),
      issuedOn: date,
      dueOn: date,
      amountMinor: minor,
      receivedMinor: minor,
      outstandingMinor: minor,
      status: z.enum(BILL_STATUSES),
      overdue: z.boolean(),
    }),
  ),
  nextCursor: cursor,
  total: z.number().int().min(0).optional(),
});
const receiptSchema: z.ZodType<Receipt> = z.object({
  id: z.string(),
  number: z.string(),
  payerId: z.string(),
  payerName: z.string(),
  receivedOn: date,
  method: z.enum(RECEIPT_METHODS),
  reference: z.string().optional(),
  amountMinor: minor,
  allocations: z.array(
    z.object({ billId: z.string(), billNumber: z.string(), amountMinor: minor }),
  ),
});
const receiptPageSchema: z.ZodType<ReceiptPage> = z.object({
  items: z.array(receiptSchema),
  nextCursor: cursor,
  total: z.number().int().min(0).optional(),
});
const statementSchema: z.ZodType<CreditStatement> = z.object({
  payerId: z.string(),
  payerName: z.string(),
  from: date,
  to: date,
  openingMinor: minor,
  billedMinor: minor,
  receivedMinor: minor,
  closingMinor: minor,
  items: z.array(
    z.object({
      id: z.string(),
      on: date,
      kind: z.enum(['bill', 'receipt']),
      number: z.string(),
      debitMinor: minor,
      creditMinor: minor,
      balanceMinor: minor,
    }),
  ),
  nextCursor: cursor,
});

export async function fetchCreditAccounts(
  { cursor: after, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CreditAccountPage> {
  const result = await api.GET('/credit-accounts', {
    params: { query: { cursor: after, limit } },
    signal,
  });
  return accountPageSchema.parse(requireData(result));
}

export async function fetchCreditAccount(
  payerId: string,
  signal?: AbortSignal,
): Promise<CreditAccount> {
  const result = await api.GET('/payers/{payerId}/credit-account', {
    params: { path: { payerId } },
    signal,
  });
  return accountSchema.parse(requireData(result));
}

export async function saveCreditAccount(
  payerId: string,
  body: CreditAccountWrite,
): Promise<CreditAccount> {
  const result = await api.PUT('/payers/{payerId}/credit-account', {
    params: { path: { payerId } },
    body,
  });
  return accountSchema.parse(requireData(result));
}

export async function fetchCreditBills(
  {
    payerId,
    status,
    cursor: after,
    limit,
  }: { payerId: string; status: CreditBillStatus | ''; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CreditBillPage> {
  const result = await api.GET('/payers/{payerId}/credit-bills', {
    params: {
      path: { payerId },
      query: { status: status || undefined, cursor: after, limit },
    },
    signal,
  });
  return billPageSchema.parse(requireData(result));
}

export async function fetchReceipts(
  { payerId, cursor: after, limit }: { payerId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ReceiptPage> {
  const result = await api.GET('/payers/{payerId}/receipts', {
    params: { path: { payerId }, query: { cursor: after, limit } },
    signal,
  });
  return receiptPageSchema.parse(requireData(result));
}

export async function fetchStatement(
  {
    payerId,
    from,
    to,
    cursor: after,
    limit,
  }: { payerId: string; from: string; to: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CreditStatement> {
  const result = await api.GET('/payers/{payerId}/credit-statement', {
    params: { path: { payerId }, query: { from, to, cursor: after, limit } },
    signal,
  });
  return statementSchema.parse(requireData(result));
}

export async function recordReceipt(
  payerId: string,
  body: ReceiptCreate,
  key: string,
): Promise<Receipt> {
  const result = await api.POST('/payers/{payerId}/receipts', {
    params: { path: { payerId }, header: { 'idempotency-key': key } },
    body,
  });
  return receiptSchema.parse(requireData(result));
}

export async function createCreditBill(encounterId: string, payerId: string, key: string) {
  const result = await api.POST('/encounters/{encounterId}/credit-bills', {
    params: { path: { encounterId }, header: { 'idempotency-key': key } },
    body: { payerId },
  });
  return requireData(result);
}

// Reconciliation. The server works the figures out; this only re-adds them, so a screen that
// disagrees with itself says so instead of showing two answers.

/** What is owed is what was billed less what was received. */
export function accountReconciles(account: CreditAccount): boolean {
  return (
    account.billedMinor - account.receivedMinor === account.outstandingMinor &&
    account.overdueMinor <= account.outstandingMinor
  );
}

/**
 * A statement adds up when the closing balance is the opening balance plus what was billed less
 * what was received, and, for a period that runs to today or later, when it is also what the
 * account says is owed. `upToDate` says whether the second check applies.
 */
export function statementReconciles(
  statement: CreditStatement,
  account: CreditAccount,
  upToDate: boolean,
): boolean {
  const adds =
    statement.openingMinor + statement.billedMinor - statement.receivedMinor ===
    statement.closingMinor;
  return adds && (!upToDate || statement.closingMinor === account.outstandingMinor);
}

/** A receipt sets all of its money against bills, no more and no less. */
export function receiptReconciles(receipt: Receipt): boolean {
  return receipt.allocations.reduce((sum, one) => sum + one.amountMinor, 0) === receipt.amountMinor;
}

// Forms. Money is typed in the hospital's currency and read on its digits.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_ERROR = 'validation.invalid_format';

export const termsFormSchema = (digits: number) =>
  z.object({
    limit: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toMinor(text, digits) !== null, AMOUNT_ERROR),
    termsDays: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .regex(/^\d{1,3}$/, AMOUNT_ERROR)
      .refine((text) => Number(text) <= 365, AMOUNT_ERROR),
  });
export type TermsFormValues = z.infer<ReturnType<typeof termsFormSchema>>;

export function toTermsWrite(
  values: TermsFormValues,
  digits: number,
  version?: number,
): CreditAccountWrite {
  return {
    creditLimitMinor: toMinor(values.limit, digits) ?? 0,
    termsDays: Number(values.termsDays),
    ...(version !== undefined ? { version } : {}),
  };
}

export const receiptFormSchema = (digits: number, today: string, outstandingMinor: number) =>
  z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .superRefine((text, context) => {
        const parsed = toMinor(text, digits);
        if (parsed === null) {
          context.addIssue({ code: 'custom', message: AMOUNT_ERROR });
        } else if (parsed < 1) {
          context.addIssue({ code: 'custom', message: 'validation.required' });
        } else if (parsed > outstandingMinor) {
          context.addIssue({ code: 'custom', message: 'insurance:credit.errors.overOwed' });
        }
      }),
    method: z.enum(RECEIPT_METHODS),
    reference: z.string().trim().max(60).regex(PLAIN_TEXT, 'validation.plain_text'),
    receivedOn: z
      .string()
      .regex(DATE, 'validation.required')
      .refine((value) => value <= today, 'insurance:credit.errors.futureDate'),
  });
export type ReceiptFormValues = z.infer<ReturnType<typeof receiptFormSchema>>;

export function toReceiptCreate(values: ReceiptFormValues, digits: number): ReceiptCreate {
  return {
    amountMinor: toMinor(values.amount, digits) ?? 0,
    method: values.method,
    receivedOn: values.receivedOn,
    ...(values.reference ? { reference: values.reference } : {}),
  };
}

/** Today as a calendar date on the hospital's clock. */
export function todayAt(timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** A calendar date some days before another, for the statement's default period. */
export function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}
