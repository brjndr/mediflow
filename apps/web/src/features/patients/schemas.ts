import { z } from 'zod';
import type { PatientPage, PatientSummary } from './types';

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const patientSummarySchema: z.ZodType<PatientSummary> = z.object({
  id: z.string(),
  tenantId: z.string(),
  mrn: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dob: z.iso.date(),
  gender: z.enum(['male', 'female', 'other']),
  phone: z.string(),
});

export const patientPageSchema: z.ZodType<PatientPage> = z.object({
  items: z.array(patientSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
