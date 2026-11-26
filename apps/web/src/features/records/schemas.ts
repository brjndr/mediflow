import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  CodingItem,
  CorrectionRequest,
  CorrectionRequestPage,
  CorrectionStatus,
  CorrectionTarget,
  CodingItemPage,
  EncounterKind,
  IncompleteRecord,
  IncompleteRecordPage,
  RecordGap,
  RecordRequest,
  RecordRequestPage,
  RecordRequester,
  RecordRequestState,
} from './types';

export const RECORDS_PAGE_SIZE = 25;
export const NAME_MAX = 200;
export const TEXT_MAX = 500;

export const GAPS = [
  'unsigned_note',
  'no_diagnosis',
  'no_discharge_summary',
  'missing_consent',
] as const satisfies readonly RecordGap[];
export const KINDS = ['opd', 'ipd', 'er', 'daycare'] as const satisfies readonly EncounterKind[];
export const REQUESTERS = [
  'patient',
  'representative',
  'insurer',
  'court',
  'hospital',
  'other',
] as const satisfies readonly RecordRequester[];
export const REQUEST_STATES = [
  'open',
  'fulfilled',
  'declined',
] as const satisfies readonly RecordRequestState[];

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const incompleteRecordSchema: z.ZodType<IncompleteRecord> = z.object({
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  kind: z.enum(KINDS),
  closedAt: z.string(),
  doctorName: z.string(),
  assignedDoctorId: z.string().optional(),
  assignedDoctorName: z.string().optional(),
  gaps: z.array(z.enum(GAPS)),
});
export const incompleteRecordPageSchema: z.ZodType<IncompleteRecordPage> =
  page(incompleteRecordSchema);

export const codingItemSchema: z.ZodType<CodingItem> = z.object({
  diagnosisId: z.string(),
  encounterId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  text: z.string(),
  code: z
    .object({
      id: z.string(),
      system: z.enum(['icd10', 'procedure']),
      code: z.string(),
      title: z.string(),
      favourite: z.boolean(),
    })
    .optional(),
  recordedAt: z.string(),
  doctorName: z.string(),
  version: z.number().int(),
});
export const codingItemPageSchema: z.ZodType<CodingItemPage> = page(codingItemSchema);

export const recordRequestSchema: z.ZodType<RecordRequest> = z.object({
  id: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  requesterKind: z.enum(REQUESTERS),
  requesterName: z.string(),
  purpose: z.string(),
  requestedOn: z.string(),
  dueOn: z.string().optional(),
  state: z.enum(REQUEST_STATES),
  createdByName: z.string(),
  closedAt: z.string().optional(),
  closedByName: z.string().optional(),
  note: z.string().optional(),
  version: z.number().int(),
});
export const recordRequestPageSchema: z.ZodType<RecordRequestPage> = page(recordRequestSchema);

/** The form that logs a request. The patient is chosen in a search box, so it is held apart. */
export const requestFormSchema = z.object({
  requesterKind: z.enum(REQUESTERS),
  requesterName: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NAME_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  purpose: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(TEXT_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  dueOn: z.string(),
});
export type RequestFormValues = z.infer<typeof requestFormSchema>;

export const closeFormSchema = z.object({
  outcome: z.enum(['fulfilled', 'declined']),
  note: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(TEXT_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type CloseFormValues = z.infer<typeof closeFormSchema>;

export const CORRECTION_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const satisfies readonly CorrectionStatus[];
export const CORRECTION_TARGETS = [
  'patient',
  'encounter',
  'document',
] as const satisfies readonly CorrectionTarget[];

export const correctionRequestSchema: z.ZodType<CorrectionRequest> = z.object({
  id: z.string(),
  patientId: z.string(),
  targetKind: z.enum(CORRECTION_TARGETS),
  targetId: z.string().optional(),
  proposed: z.string(),
  reason: z.string(),
  status: z.enum(CORRECTION_STATUSES),
  requestedBy: z.string(),
  requestedAt: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  decisionReason: z.string().optional(),
  version: z.number().int(),
});
export const correctionRequestPageSchema: z.ZodType<CorrectionRequestPage> =
  page(correctionRequestSchema);

const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(max, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text');

/** Asking for a correction to the patient record: what should change, and why. */
export const correctionFormSchema = z.object({ proposed: plain(1000), reason: plain(300) });
export type CorrectionFormValues = z.infer<typeof correctionFormSchema>;

/** Deciding a request: the reason, whichever way it goes. */
export const decisionFormSchema = z.object({ reason: plain(300) });
export type DecisionFormValues = z.infer<typeof decisionFormSchema>;
