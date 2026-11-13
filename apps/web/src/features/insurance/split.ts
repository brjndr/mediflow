import { z } from 'zod';
import { api, requireData } from '@/shared/api';
import type { CoverageSplit, CoverageSplitLine } from './types';

// Split billing (IN-03, #183): the server divides a visit's charge ledger between the patient
// and the payer; the screen shows its figures and only checks that they add up.

export const SPLIT_REASONS = [
  'covered',
  'copay',
  'not_covered',
  'service_limit',
  'sum_insured',
] as const;

const money = z.number().int();
const lineSchema: z.ZodType<CoverageSplitLine> = z.object({
  chargeId: z.string(),
  description: z.string(),
  ledgerMinor: money,
  ratedMinor: money,
  payerMinor: money.min(0),
  patientMinor: money.min(0),
  reason: z.enum(SPLIT_REASONS),
});
export const splitSchema: z.ZodType<CoverageSplit> = z.object({
  encounterId: z.string(),
  policyId: z.string(),
  payerName: z.string(),
  planName: z.string(),
  agreementName: z.string().optional(),
  copayPercent: z.number().int().min(0).max(100),
  lines: z.array(lineSchema),
  ledgerMinor: money,
  rateAdjustmentMinor: money,
  payerMinor: money.min(0),
  patientMinor: money.min(0),
  saved: z
    .object({
      savedAt: z.string(),
      ledgerMinor: money,
      payerMinor: money,
      patientMinor: money,
    })
    .optional(),
  stale: z.boolean(),
});

/**
 * Whether the figures add up, which is the rule of the split: every line is shared out in full,
 * the lines make the totals, and the ledger plus the rate adjustment is what the two share.
 * Nothing is worked out for display from this; it only says whether to trust what is shown.
 */
export function splitReconciles(split: CoverageSplit): boolean {
  const sum = (pick: (line: CoverageSplitLine) => number) =>
    split.lines.reduce((total, line) => total + pick(line), 0);
  return (
    split.lines.every((line) => line.payerMinor + line.patientMinor === line.ratedMinor) &&
    sum((line) => line.ledgerMinor) === split.ledgerMinor &&
    sum((line) => line.payerMinor) === split.payerMinor &&
    sum((line) => line.patientMinor) === split.patientMinor &&
    split.ledgerMinor + split.rateAdjustmentMinor === split.payerMinor + split.patientMinor
  );
}

export async function fetchSplit(
  encounterId: string,
  signal?: AbortSignal,
): Promise<CoverageSplit> {
  const result = await api.GET('/encounters/{encounterId}/coverage-split', {
    params: { path: { encounterId } },
    signal,
  });
  return splitSchema.parse(requireData(result));
}

export async function saveSplit(encounterId: string, key: string): Promise<CoverageSplit> {
  const result = await api.POST('/encounters/{encounterId}/coverage-split', {
    params: { path: { encounterId }, header: { 'idempotency-key': key } },
  });
  return splitSchema.parse(requireData(result));
}
