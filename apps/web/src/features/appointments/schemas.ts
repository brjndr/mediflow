import { z } from 'zod';
import type { AppointmentPage, AppointmentStatus, AppointmentSummary } from './types';

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const satisfies readonly AppointmentStatus[];

/** How many days one list may cover, as the API allows. */
export const MAX_RANGE_DAYS = 31;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const appointmentSummarySchema: z.ZodType<AppointmentSummary> = z.object({
  id: z.string(),
  tenantId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  doctorId: z.string(),
  doctorName: z.string(),
  departmentName: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  version: z.number().int().min(1),
});

export const appointmentPageSchema: z.ZodType<AppointmentPage> = z.object({
  items: z.array(appointmentSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
