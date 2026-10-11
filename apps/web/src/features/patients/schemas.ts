import { z } from 'zod';
import type { PatientDuplicateMatches, PatientPage, PatientRecord, PatientSummary } from './types';

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

export const duplicateMatchesSchema: z.ZodType<PatientDuplicateMatches> = z.object({
  items: z.array(patientSummarySchema),
});

const GENDERS = ['male', 'female', 'other'] as const;
/** Today as a calendar date in the given timezone (en-CA formats as YYYY-MM-DD). */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
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
