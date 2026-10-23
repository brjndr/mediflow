import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  LabRejectReason,
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
