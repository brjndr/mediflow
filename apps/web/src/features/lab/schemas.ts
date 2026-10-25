import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  LabAnalyte,
  LabOrderResults,
  LabRejectReason,
  LabResult,
  LabResultPage,
  LabResultRange,
  LabSample,
  LabSampleStatus,
  LabStage,
  LabWorkItem,
  LabWorkItemPage,
  OrderPriority,
} from './types';

export const LAB_STAGES = [
  'to_collect',
  'collected',
  'received',
  'completed',
] as const satisfies readonly LabStage[];

/** Stat first: the order the worklist is sorted in. */
export const PRIORITIES = ['stat', 'urgent', 'routine'] as const satisfies readonly OrderPriority[];

const SAMPLE_STATUSES = [
  'collected',
  'received',
  'rejected',
] as const satisfies readonly LabSampleStatus[];

export const REJECT_REASONS = [
  'haemolysed',
  'clotted',
  'insufficient',
  'mislabelled',
  'wrong_container',
  'contaminated',
  'other',
] as const satisfies readonly LabRejectReason[];

const SAMPLE_TYPES = [
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'swab',
  'sputum',
  'csf',
  'tissue',
  'other',
] as const;

const ORDER_STATUSES = ['placed', 'accepted', 'in_progress', 'completed', 'cancelled'] as const;

/** The planned contract's limit for a rejection's note. */
export const NOTE_MAX = 200;

// Responses are validated where they enter the app, so screens can trust their shape.

export const labSampleSchema: z.ZodType<LabSample> = z.object({
  id: z.string(),
  tenantId: z.string(),
  orderId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  accessionId: z.string(),
  sampleType: z.enum(SAMPLE_TYPES),
  container: z.string().optional(),
  status: z.enum(SAMPLE_STATUSES),
  collectedAt: z.string(),
  collectedByName: z.string(),
  receivedAt: z.string().optional(),
  receivedByName: z.string().optional(),
  rejectedAt: z.string().optional(),
  rejectedByName: z.string().optional(),
  rejectReason: z.enum(REJECT_REASONS).optional(),
  rejectNote: z.string().optional(),
  version: z.number().int(),
});

export const labWorkItemSchema: z.ZodType<LabWorkItem> = z.object({
  orderId: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  patientDob: z.string().optional(),
  labTestId: z.string().optional(),
  itemCode: z.string().optional(),
  itemName: z.string(),
  priority: z.enum(PRIORITIES),
  instructions: z.string().optional(),
  placedAt: z.string(),
  orderedByName: z.string(),
  orderStatus: z.enum(ORDER_STATUSES),
  sampleType: z.enum(SAMPLE_TYPES),
  container: z.string().optional(),
  stage: z.enum(LAB_STAGES),
  sample: labSampleSchema.optional(),
  rejectedSamples: z.number().int().min(0),
  resultsEntered: z.number().int().min(0),
  resultsToVerify: z.number().int().min(0),
});

export const labWorkItemPageSchema: z.ZodType<LabWorkItemPage> = z.object({
  items: z.array(labWorkItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** Why a sample is rejected: a reason, and a note that `other` needs. */
export const rejectSchema = z
  .object({
    // Empty until one is chosen, and required.
    reason: z
      .union([z.enum(REJECT_REASONS), z.literal('')])
      .refine((value) => value !== '', { message: 'lab:reject.errors.reason' })
      .transform((value) => value as LabRejectReason),
    note: z
      .string()
      .trim()
      .max(NOTE_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  })
  .refine((values) => values.reason !== 'other' || values.note.length > 0, {
    path: ['note'],
    message: 'lab:reject.errors.note',
  });
export type RejectValues = z.input<typeof rejectSchema>;
export type RejectOutput = z.output<typeof rejectSchema>;

export const RESULT_FLAGS = ['normal', 'low', 'high', 'critical_low', 'critical_high'] as const;

/** The API's limits for a result (#95). */
export const VALUE_MAX = 500;
export const COMMENT_MAX = 500;
export const REASON_MAX = 200;

/**
 * A number as the API takes it: up to nine digits, a point and up to six decimals, a minus sign
 * allowed. `.5` and `5.` are refused, as the API refuses them (422 `invalid_number`).
 */
export const DECIMAL = /^-?\d{1,9}(\.\d{1,6})?$/;

const rangeSchema: z.ZodType<LabResultRange> = z.object({
  low: z.number().optional(),
  high: z.number().optional(),
  criticalLow: z.number().optional(),
  criticalHigh: z.number().optional(),
  note: z.string().optional(),
});

const resultType = z.enum(['numeric', 'text']);

const analyteSchema: z.ZodType<LabAnalyte> = z.object({
  labTestId: z.string(),
  code: z.string(),
  name: z.string(),
  resultType,
  unit: z.string().optional(),
  range: rangeSchema.optional(),
});

export const labResultSchema: z.ZodType<LabResult> = z.object({
  id: z.string(),
  tenantId: z.string(),
  sampleId: z.string(),
  orderId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  labTestId: z.string(),
  testCode: z.string(),
  testName: z.string(),
  resultType,
  value: z.string(),
  unit: z.string().optional(),
  range: rangeSchema.optional(),
  flag: z.enum(RESULT_FLAGS).optional(),
  comment: z.string().optional(),
  status: z.enum(['entered', 'verified']),
  enteredAt: z.string(),
  enteredByName: z.string(),
  verifiedAt: z.string().optional(),
  verifiedByName: z.string().optional(),
  amendsId: z.string().optional(),
  amendmentReason: z.string().optional(),
  amendedById: z.string().optional(),
  collectedAt: z.string(),
  acknowledgedAt: z.string().optional(),
  acknowledgedByName: z.string().optional(),
  version: z.number().int(),
});

/** A page of a patient's released results (#92). */
export const labResultPageSchema: z.ZodType<LabResultPage> = z.object({
  items: z.array(labResultSchema),
  nextCursor: z.string().nullable(),
});

/** A critical result a doctor still has to acknowledge (#92): verified, critical, not yet seen. */
export const needsAcknowledging = (result: LabResult) =>
  result.status === 'verified' &&
  (result.flag === 'critical_low' || result.flag === 'critical_high') &&
  result.acknowledgedAt === undefined;

export const labOrderResultsSchema: z.ZodType<LabOrderResults> = z.object({
  orderId: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  itemName: z.string(),
  priority: z.enum(PRIORITIES),
  orderStatus: z.enum(ORDER_STATUSES),
  sample: labSampleSchema.optional(),
  analytes: z.array(analyteSchema),
  results: z.array(labResultSchema),
  awaitingVerification: z.array(z.string()).optional(),
});

/** A typed result: a number for a numeric test, plain lines of text otherwise. */
const resultValue = (numeric: boolean, value: string) =>
  numeric ? DECIMAL.test(value) : PLAIN_LINES.test(value);

const comment = z
  .string()
  .trim()
  .max(COMMENT_MAX, 'validation.too_big')
  .regex(PLAIN_LINES, 'validation.plain_text');

/**
 * Result entry: one row per test not yet resulted, any of them filled in. A row left empty is
 * not sent; a comment needs its result. At least one result is entered.
 */
export const entrySchema = z
  .object({
    rows: z.array(
      z
        .object({
          labTestId: z.string(),
          numeric: z.boolean(),
          value: z.string().trim().max(VALUE_MAX, 'validation.too_big'),
          comment,
        })
        .superRefine((row, context) => {
          if (row.value && !resultValue(row.numeric, row.value)) {
            context.addIssue({
              code: 'custom',
              path: ['value'],
              message: row.numeric ? 'lab:results.errors.number' : 'validation.plain_text',
            });
          }
          if (row.comment && !row.value) {
            context.addIssue({
              code: 'custom',
              path: ['value'],
              message: 'lab:results.errors.commentNeedsValue',
            });
          }
        }),
    ),
  })
  .superRefine((values, context) => {
    if (values.rows.length > 0 && values.rows.every((row) => !row.value)) {
      context.addIssue({
        code: 'custom',
        path: ['rows', 0, 'value'],
        message: 'lab:results.errors.none',
      });
    }
  });
export type EntryValues = z.input<typeof entrySchema>;
export type EntryOutput = z.output<typeof entrySchema>;

/** Verifying: the results the verifier read, ticked; at least one. */
export const verifySchema = z
  .object({ ticked: z.array(z.object({ id: z.string(), checked: z.boolean() })) })
  .refine((values) => values.ticked.some((each) => each.checked), {
    path: ['ticked'],
    message: 'lab:verify.errors.none',
  });
export type VerifyValues = z.input<typeof verifySchema>;

/** Correcting a result: the whole new value, an optional comment and a reason. */
export const amendSchema = (numeric: boolean) =>
  z.object({
    value: z
      .string()
      .trim()
      .min(1, 'lab:amend.errors.value')
      .max(VALUE_MAX, 'validation.too_big')
      .refine((value) => resultValue(numeric, value), {
        message: numeric ? 'lab:results.errors.number' : 'validation.plain_text',
      }),
    comment,
    reason: z
      .string()
      .trim()
      .min(1, 'lab:amend.errors.reason')
      .max(REASON_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
  });
export type AmendValues = z.input<ReturnType<typeof amendSchema>>;
