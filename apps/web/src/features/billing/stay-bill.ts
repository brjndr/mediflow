import type { components } from '@mediflow/contract';
import { z } from 'zod';
import { api, requireData } from '@/shared/api';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { PAYMENT_METHODS } from './schemas';

// The running bill of an inpatient stay, its deposits and its estimate (DS-03, #166). The
// endpoints are in the planned contract: the API has none yet (#169).

type Schemas = components['schemas'];
export type RunningBill = Schemas['RunningBill'];
export type RunningBillLine = Schemas['RunningBillLine'];
export type Deposit = Schemas['Deposit'];
export type DepositCreate = Schemas['DepositCreate'];

export const ESTIMATE_NOTE_MAX = 300;

const SOURCES = ['service', 'order', 'dispense', 'bed', 'procedure', 'manual'] as const;

export const runningBillSchema: z.ZodType<RunningBill> = z.object({
  admissionId: z.string(),
  encounterId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  status: z.enum(['admitted', 'discharged', 'cancelled']),
  asOf: z.string(),
  lines: z.array(
    z.object({
      source: z.enum(SOURCES),
      count: z.number().int(),
      totalMinor: z.number().int(),
      accruing: z.boolean().optional(),
    }),
  ),
  chargesMinor: z.number().int(),
  invoicedMinor: z.number().int(),
  paidMinor: z.number().int(),
  depositsMinor: z.number().int(),
  balanceMinor: z.number().int(),
  estimateMinor: z.number().int().optional(),
  estimateNote: z.string().optional(),
});

export const depositSchema: z.ZodType<Deposit> = z.object({
  id: z.string(),
  tenantId: z.string(),
  admissionId: z.string(),
  amountMinor: z.number().int(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().optional(),
  recordedByName: z.string(),
  at: z.string(),
});

const depositListSchema = z.object({ items: z.array(depositSchema) });

/**
 * The estimate form: an amount (read on its digits by the caller; nothing is refused here but an
 * empty or unreadable amount) and an optional note.
 */
export function createEstimateSchema(toAmount: (text: string) => number | null) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format'),
    note: z
      .string()
      .trim()
      .max(ESTIMATE_NOTE_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
}
export type EstimateInput = z.input<ReturnType<typeof createEstimateSchema>>;
export type EstimateValues = z.output<ReturnType<typeof createEstimateSchema>>;

export async function fetchRunningBill(
  admissionId: string,
  signal?: AbortSignal,
): Promise<RunningBill> {
  const result = await api.GET('/admissions/{admissionId}/bill', {
    params: { path: { admissionId } },
    signal,
  });
  return runningBillSchema.parse(requireData(result));
}

export async function fetchDeposits(admissionId: string, signal?: AbortSignal): Promise<Deposit[]> {
  const result = await api.GET('/admissions/{admissionId}/deposits', {
    params: { path: { admissionId } },
    signal,
  });
  return depositListSchema.parse(requireData(result)).items;
}

export async function takeDeposit(
  admissionId: string,
  body: DepositCreate,
  idempotencyKey: string,
): Promise<Deposit> {
  const result = await api.POST('/admissions/{admissionId}/deposits', {
    params: { path: { admissionId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return depositSchema.parse(requireData(result));
}

export async function setEstimate(
  admissionId: string,
  body: { amountMinor: number; note?: string },
  idempotencyKey: string,
): Promise<RunningBill> {
  const result = await api.PUT('/admissions/{admissionId}/bill-estimate', {
    params: { path: { admissionId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return runningBillSchema.parse(requireData(result));
}

// The final bill and settlement of the stay (DS-04, #167).

export type StaySettlement = Schemas['StaySettlement'];
export type DischargePolicy = Schemas['DischargePolicy'];
export type DischargePolicyMode = DischargePolicy['mode'];
export type ClearanceReason = StaySettlement['clearance']['reasons'][number];
export const DISCHARGE_POLICY_MODES = ['off', 'warn', 'block'] as const;
export const REASON_MAX = 200;

export const staySettlementSchema: z.ZodType<StaySettlement> = z.object({
  admissionId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  status: z.enum(['admitted', 'discharged', 'cancelled']),
  chargesMinor: z.number().int(),
  unbilledMinor: z.number().int(),
  invoicedMinor: z.number().int(),
  creditedMinor: z.number().int(),
  paidMinor: z.number().int(),
  dueMinor: z.number().int(),
  depositsMinor: z.number().int(),
  depositsAppliedMinor: z.number().int(),
  depositsRefundedMinor: z.number().int(),
  depositsHeldMinor: z.number().int(),
  excessDepositMinor: z.number().int(),
  invoices: z.array(
    z.object({
      id: z.string(),
      number: z.string().optional(),
      status: z.enum(['draft', 'issued', 'paid', 'void']),
      totalMinor: z.number().int(),
      creditedMinor: z.number().int(),
      paidMinor: z.number().int(),
    }),
  ),
  policy: z.enum(DISCHARGE_POLICY_MODES),
  clearance: z.object({
    cleared: z.boolean(),
    reasons: z.array(z.enum(['unbilled', 'draft_invoice', 'balance_due', 'excess_deposit'])),
  }),
});

export const dischargePolicySchema: z.ZodType<DischargePolicy> = z.object({
  mode: z.enum(DISCHARGE_POLICY_MODES),
});

/** The form to pay back the deposit held beyond what is due: an amount up to it, a mode, a reason. */
export function createDepositRefundSchema(
  toAmount: (text: string) => number | null,
  excessMinor: number,
) {
  return z.object({
    amount: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .refine((text) => toAmount(text) !== null, 'validation.invalid_format')
      .refine((text) => (toAmount(text) ?? 1) > 0, 'billing:refund.amountPositive')
      .refine((text) => (toAmount(text) ?? 0) <= excessMinor, 'billing:settlement.refund.tooMuch'),
    method: z.enum(PAYMENT_METHODS),
    reason: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(REASON_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
}
export type DepositRefundInput = z.input<ReturnType<typeof createDepositRefundSchema>>;
export type DepositRefundValues = z.output<ReturnType<typeof createDepositRefundSchema>>;

export async function fetchSettlement(
  admissionId: string,
  signal?: AbortSignal,
): Promise<StaySettlement> {
  const result = await api.GET('/admissions/{admissionId}/settlement', {
    params: { path: { admissionId } },
    signal,
  });
  return staySettlementSchema.parse(requireData(result));
}

export async function applyDeposits(
  admissionId: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<StaySettlement> {
  const result = await api.POST('/admissions/{admissionId}/deposits/apply', {
    params: { path: { admissionId }, header: { 'idempotency-key': idempotencyKey } },
    body: { invoiceId },
  });
  return staySettlementSchema.parse(requireData(result));
}

export async function refundDeposits(
  admissionId: string,
  body: Schemas['DepositRefund'],
  idempotencyKey: string,
): Promise<StaySettlement> {
  const result = await api.POST('/admissions/{admissionId}/deposits/refund', {
    params: { path: { admissionId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return staySettlementSchema.parse(requireData(result));
}

export async function fetchDischargePolicy(signal?: AbortSignal): Promise<DischargePolicy> {
  const result = await api.GET('/billing/discharge-policy', { signal });
  return dischargePolicySchema.parse(requireData(result));
}

export async function putDischargePolicy(
  mode: DischargePolicyMode,
  idempotencyKey: string,
): Promise<DischargePolicy> {
  const result = await api.PUT('/billing/discharge-policy', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body: { mode },
  });
  return dischargePolicySchema.parse(requireData(result));
}
