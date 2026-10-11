import { z } from 'zod';
import type {
  PatientDuplicateMatch,
  PatientDuplicateMatches,
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
/** Today as a YYYY-MM-DD calendar date in the given (hospital) timezone. */
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

/** The registration form. Messages are translation keys; rules without one get their kind's. */
export const createPatientFormSchema = (today: string) =>
  z.object({
    firstName: z.string().trim().min(1, 'validation.required').max(100),
    lastName: z.string().trim().min(1, 'validation.required').max(100),
    dob: z.iso
      .date('validation.invalid_format')
      .refine((value) => value <= today, 'validation.invalid_format'),
    gender: z.enum(GENDERS, 'validation.required'),
    phone: z
      .string()
      .trim()
      .regex(/^[+0-9() -]{5,20}$/, 'validation.invalid_format'),
    email: z.union([z.literal(''), z.email('validation.invalid_format').max(254)]),
    address: z.string().trim().max(500),
    contactConsent: z.boolean(),
  });

export type PatientFormValues = z.output<ReturnType<typeof createPatientFormSchema>>;
