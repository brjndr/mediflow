import { z } from 'zod';
import { toMinor } from '@/features/services';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  PatientPolicy,
  PatientPolicyCreate,
  PreAuth,
  PreAuthCreate,
  PreAuthDecision,
} from './types';

export const RELATIONSHIPS = ['self', 'spouse', 'child', 'parent', 'other'] as const;

/** Where a bill stands against an approved limit. */
export type LimitLevel = 'ok' | 'near' | 'reached';
/** The share of the limit at which the desk is warned. */
export const NEAR_LIMIT_PERCENT = 80;

/** Whole percent of the limit used (not capped), or null when there is no limit to compare. */
export function limitUsedPercent(billedMinor: number, approvedMinor: number): number | null {
  if (approvedMinor <= 0) return null;
  return Math.floor((billedMinor * 100) / approvedMinor);
}

export function limitLevel(billedMinor: number, approvedMinor: number): LimitLevel {
  const used = limitUsedPercent(billedMinor, approvedMinor);
  if (used === null || billedMinor >= approvedMinor) return 'reached';
  return used >= NEAR_LIMIT_PERCENT ? 'near' : 'ok';
}

export const policySchema: z.ZodType<PatientPolicy> = z.object({
  id: z.string(),
  patientId: z.string(),
  payerId: z.string(),
  payerName: z.string(),
  planId: z.string(),
  planName: z.string(),
  policyNumber: z.string(),
  memberId: z.string().optional(),
  holderName: z.string(),
  relationship: z.enum(RELATIONSHIPS),
  validFrom: z.string(),
  validTo: z.string().optional(),
  status: z.enum(['active', 'expired', 'ended']),
  preAuthRequired: z.boolean(),
  version: z.number().int().min(1),
});
export const policyListSchema = z.array(policySchema);

export const preAuthSchema: z.ZodType<PreAuth> = z.object({
  id: z.string(),
  patientId: z.string(),
  policyId: z.string(),
  payerName: z.string(),
  planName: z.string(),
  policyNumber: z.string(),
  encounterId: z.string().optional(),
  treatment: z.string(),
  requestedMinor: z.number().int().min(0),
  approvedMinor: z.number().int().min(0).optional(),
  billedMinor: z.number().int().min(0),
  status: z.enum(['submitted', 'approved', 'rejected', 'cancelled']),
  referenceNumber: z.string().optional(),
  decisionNote: z.string().optional(),
  documents: z.array(z.string()),
  requestedAt: z.string(),
  decidedAt: z.string().optional(),
  version: z.number().int().min(1),
});
export const preAuthListSchema = z.array(preAuthSchema);

const plain = (max: number) =>
  z.string().trim().max(max).regex(PLAIN_TEXT, 'validation.plain_text');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const policyFormSchema = z
  .object({
    payerId: z.string().min(1, 'validation.required'),
    planId: z.string().min(1, 'validation.required'),
    policyNumber: plain(40).min(1, 'validation.required'),
    memberId: plain(40),
    holderName: plain(100).min(1, 'validation.required'),
    relationship: z.enum(RELATIONSHIPS),
    validFrom: z.string().regex(DATE, 'validation.required'),
    validTo: z.string(),
  })
  .superRefine((values, context) => {
    if (values.validTo !== '' && values.validTo < values.validFrom) {
      context.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'insurance:policy.errors.endBeforeStart',
      });
    }
  });
export type PolicyFormValues = z.infer<typeof policyFormSchema>;

export function toPolicyCreate(values: PolicyFormValues): PatientPolicyCreate {
  return {
    planId: values.planId,
    policyNumber: values.policyNumber,
    ...(values.memberId ? { memberId: values.memberId } : {}),
    holderName: values.holderName,
    relationship: values.relationship,
    validFrom: values.validFrom,
    ...(values.validTo ? { validTo: values.validTo } : {}),
  };
}

const amount = (digits: number) =>
  z
    .string()
    .trim()
    .min(1, 'validation.required')
    .refine((value) => toMinor(value, digits) !== null, 'validation.invalid_format');

/** What is enclosed with a request, typed one name to a line. */
export function documentNames(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export const preAuthFormSchema = (digits: number) =>
  z.object({
    policyId: z.string().min(1, 'validation.required'),
    treatment: plain(300).min(1, 'validation.required'),
    requested: amount(digits),
    documents: z
      .string()
      .max(2200)
      .refine((value) => {
        const names = documentNames(value);
        return names.length <= 20 && names.every((n) => n.length <= 100 && PLAIN_TEXT.test(n));
      }, 'validation.invalid_format'),
  });
export type PreAuthFormValues = z.infer<ReturnType<typeof preAuthFormSchema>>;

export function toPreAuthCreate(
  values: PreAuthFormValues,
  digits: number,
  encounterId?: string,
): PreAuthCreate {
  return {
    policyId: values.policyId,
    ...(encounterId ? { encounterId } : {}),
    treatment: values.treatment,
    requestedMinor: toMinor(values.requested, digits) ?? 0,
    documents: documentNames(values.documents),
  };
}

export const decisionFormSchema = (digits: number) =>
  z
    .object({
      outcome: z.enum(['approved', 'rejected']),
      approved: z
        .string()
        .trim()
        .refine(
          (value) => value === '' || toMinor(value, digits) !== null,
          'validation.invalid_format',
        ),
      referenceNumber: plain(60),
      note: plain(300),
    })
    .superRefine((values, context) => {
      if (values.outcome === 'approved' && values.approved === '') {
        context.addIssue({ code: 'custom', path: ['approved'], message: 'validation.required' });
      }
    });
export type DecisionFormValues = z.infer<ReturnType<typeof decisionFormSchema>>;

export function toDecision(
  values: DecisionFormValues,
  digits: number,
  version: number,
): PreAuthDecision {
  return {
    version,
    outcome: values.outcome,
    ...(values.outcome === 'approved'
      ? { approvedMinor: toMinor(values.approved, digits) ?? 0 }
      : {}),
    ...(values.referenceNumber ? { referenceNumber: values.referenceNumber } : {}),
    ...(values.note ? { note: values.note } : {}),
  };
}
