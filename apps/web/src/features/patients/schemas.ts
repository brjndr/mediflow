import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  PatientDuplicateMatch,
  PatientDuplicateMatches,
  PatientMerge,
  PatientMergePreview,
  PatientPage,
  PatientRecord,
  PatientSummary,
} from './types';

/** Responses are validated where they enter the app, so screens can trust their shape. */
const summaryShape = {
  id: z.string(),
  tenantId: z.string(),
  mrn: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dob: z.iso.date(),
  gender: z.enum(['male', 'female', 'other']),
  phone: z.string(),
  legacyId: z.string().optional(),
  mergedInto: z.string().optional(),
};

export const patientSummarySchema: z.ZodType<PatientSummary> = z.object(summaryShape);

export const patientPageSchema: z.ZodType<PatientPage> = z.object({
  items: z.array(patientSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const patientRecordSchema: z.ZodType<PatientRecord> = z.object({
  ...summaryShape,
  email: z.string().optional(),
  address: z.string().optional(),
  contactConsent: z
    .object({ given: z.boolean(), at: z.iso.datetime(), recordedBy: z.string() })
    .optional(),
  version: z.number().int().min(1),
});

export const duplicateMatchSchema: z.ZodType<PatientDuplicateMatch> = z.object({
  firstName: z.string(),
  lastName: z.string(),
  dob: z.iso.date(),
  maskedMrn: z.string(),
  maskedPhone: z.string(),
});

export const duplicateMatchesSchema: z.ZodType<PatientDuplicateMatches> = z.object({
  items: z.array(duplicateMatchSchema),
});

const GENDERS = ['male', 'female', 'other'] as const;

/**
 * Today as a YYYY-MM-DD calendar date in the given (hospital) timezone. Built on `Intl` rather
 * than the shared `todayIn` (date-fns-tz), which would put that library in this feature's
 * chunk for one date.
 */
export function todayIn(timeZone: string): string {
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
/**
 * The registration and edit form. Messages are translation keys; rules without one get their
 * kind's. With `contact: false` (a role that may not see contact details) the phone, email and
 * address are not on the form, so they have no rules: they stay empty and are never sent.
 */
export const createPatientFormSchema = (today: string, { contact = true } = {}) =>
  z.object({
    firstName: z.string().trim().min(1, 'validation.required').max(100),
    lastName: z.string().trim().min(1, 'validation.required').max(100),
    dob: z.iso
      .date('validation.invalid_format')
      .refine((value) => value <= today, 'validation.invalid_format'),
    gender: z.enum(GENDERS, 'validation.required'),
    phone: contact
      ? z
          .string()
          .trim()
          .regex(/^[+0-9() -]{5,20}$/, 'validation.invalid_format')
      : z.string(),
    email: contact
      ? z.union([z.literal(''), z.email('validation.invalid_format').max(254)])
      : z.string(),
    address: contact ? z.string().trim().max(500) : z.string(),
    legacyId: z.string().trim().max(50).regex(PLAIN_TEXT, 'validation.plain_text'),
    contactConsent: z.boolean(),
  });

export type PatientFormValues = z.output<ReturnType<typeof createPatientFormSchema>>;

/** Most days a hospital may allow for undoing a merge (the API's limit). */
export const UNMERGE_WINDOW_MAX = 365;

export const patientMergeSchema: z.ZodType<PatientMerge> = z.object({
  id: z.string(),
  sourcePatientId: z.string(),
  targetPatientId: z.string(),
  reason: z.string(),
  moved: z.record(z.string(), z.number().int()),
  mergedBy: z.string(),
  mergedAt: z.iso.datetime(),
  unmergedBy: z.string().optional(),
  unmergedAt: z.iso.datetime().optional(),
  unmergeReason: z.string().optional(),
});

export const patientMergePreviewSchema: z.ZodType<PatientMergePreview> = z.object({
  sourcePatientId: z.string(),
  targetPatientId: z.string(),
  sourceVersion: z.number().int(),
  targetVersion: z.number().int(),
  moves: z.record(z.string(), z.number().int()),
});

export const patientMergeListSchema = z.object({
  items: z.array(patientMergeSchema),
  nextCursor: z.null(),
});

export const MERGE_REASON_MAX = 500;

/** The reason for a merge: kept with it for ever, so plain text as the API insists. */
export const mergeFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(MERGE_REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type MergeFormValues = z.infer<typeof mergeFormSchema>;

export const patientSettingsSchema = z.object({
  unmergeWindowDays: z.number().int().min(0).max(UNMERGE_WINDOW_MAX),
});

export const unmergeFormSchema = mergeFormSchema;

/** The days a merge may be undone, typed as digits: 0 turns unmerging off. */
export const windowFormSchema = z.object({
  days: z
    .string()
    .trim()
    .regex(/^[0-9]{1,3}$/, 'patients:merge.settings.invalid')
    .refine((value) => Number(value) <= UNMERGE_WINDOW_MAX, 'patients:merge.settings.invalid'),
});
export type WindowFormValues = z.infer<typeof windowFormSchema>;
