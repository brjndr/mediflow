import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ClinicalNote,
  ClinicalNotePage,
  Diagnosis,
  DiagnosisCreate,
  DiagnosisKind,
  DiagnosisPage,
  Encounter,
  EncounterPage,
  EncounterStatus,
} from './types';

export const ENCOUNTER_STATUSES = [
  'open',
  'closed',
  'cancelled',
] as const satisfies readonly EncounterStatus[];
export const DIAGNOSIS_KINDS = ['provisional', 'final'] as const satisfies readonly DiagnosisKind[];

/** The API's limits (`apps/api/src/features/clinical/schemas.ts`). */
export const REASON_MAX = 200;
export const DIAGNOSIS_TEXT_MAX = 300;

// Responses are validated where they enter the app, so screens can trust their shape.

export const encounterSchema: z.ZodType<Encounter> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  type: z.enum(['opd', 'ipd', 'er', 'daycare']),
  status: z.enum(ENCOUNTER_STATUSES),
  appointmentId: z.string().optional(),
  queueTokenId: z.string().optional(),
  attendingDoctorId: z.string().optional(),
  attendingDoctorName: z.string().optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  openedAt: z.string(),
  openedByName: z.string(),
  endedAt: z.string().optional(),
  endedByName: z.string().optional(),
  cancelReason: z.string().optional(),
  version: z.number().int(),
});

export const encounterPageSchema: z.ZodType<EncounterPage> = z.object({
  items: z.array(encounterSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const noteSchema: z.ZodType<ClinicalNote> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  status: z.enum(['draft', 'signed']),
  // The rich text document; sanitized again wherever it is shown or edited.
  body: z.record(z.string(), z.unknown()),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().optional(),
  amendsId: z.string().optional(),
  amendmentReason: z.string().optional(),
  amendedById: z.string().optional(),
  version: z.number().int(),
});

export const notePageSchema: z.ZodType<ClinicalNotePage> = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const diagnosisSchema: z.ZodType<Diagnosis> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  codeId: z.string().optional(),
  code: z.string().optional(),
  codeTitle: z.string().optional(),
  text: z.string().optional(),
  kind: z.enum(DIAGNOSIS_KINDS),
  recordedAt: z.string(),
  recordedByName: z.string(),
  retractedAt: z.string().optional(),
  retractedByName: z.string().optional(),
  retractionReason: z.string().optional(),
});

export const diagnosisPageSchema: z.ZodType<DiagnosisPage> = z.object({
  items: z.array(diagnosisSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** A reason for cancelling, amending or retracting: one line of plain text, required. */
export const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type ReasonValues = z.infer<typeof reasonSchema>;

/**
 * A diagnosis as typed: a code chosen from the search (its id, code and title, kept to show it),
 * words, or both. Neither is refused, as the API refuses it.
 */
export const diagnosisFormSchema = z
  .object({
    codeId: z.string(),
    text: z
      .string()
      .trim()
      .max(DIAGNOSIS_TEXT_MAX, 'validation.too_big')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    kind: z.enum(DIAGNOSIS_KINDS),
  })
  .superRefine((values, context) => {
    if (values.codeId === '' && values.text === '') {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'clinical:diagnoses.form.codeOrText',
      });
    }
  });
export type DiagnosisValues = z.input<typeof diagnosisFormSchema>;

export const blankDiagnosis: DiagnosisValues = { codeId: '', text: '', kind: 'provisional' };

export function toDiagnosisCreate(values: z.output<typeof diagnosisFormSchema>): DiagnosisCreate {
  return {
    kind: values.kind,
    ...(values.codeId ? { codeId: values.codeId } : {}),
    ...(values.text ? { text: values.text } : {}),
  };
}

/** How a diagnosis reads: its code and title as recorded, its words, or both. */
export function diagnosisName(diagnosis: Diagnosis): string {
  const coded = diagnosis.code ? `${diagnosis.code} ${diagnosis.codeTitle ?? ''}`.trim() : '';
  return [coded, diagnosis.text].filter(Boolean).join(' · ');
}
