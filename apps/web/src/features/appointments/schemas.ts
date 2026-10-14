import { z } from 'zod';
import { PLAIN_LINES } from '@/shared/utils/text';
import type {
  Appointment,
  AppointmentPage,
  AppointmentStatus,
  AppointmentSummary,
  FreeSlots,
  TimeSlot,
} from './types';

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

export const appointmentSchema: z.ZodType<Appointment> = z.object({
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
  reason: z.string().optional(),
});

const timeSlotSchema: z.ZodType<TimeSlot> = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
});

export const freeSlotsSchema: z.ZodType<FreeSlots> = z.object({
  doctorId: z.string(),
  day: z.string(),
  slotMinutes: z.number().int(),
  slots: z.array(timeSlotSchema),
});

/** As long as the API keeps a reason. */
export const MAX_REASON = 500;
/** How far ahead the API offers free slots. */
export const BOOK_AHEAD_DAYS = 90;

/**
 * The booking form. The patient and the slot are chosen, not typed: the fields hold their ids
 * and the slot's start. `extensions` holds the fields other features add through the
 * `appointment.form.fields` slot, each under its own feature id.
 */
export const bookingSchema = z.object({
  patientId: z.string().min(1, 'appointments:book.errors.patient'),
  doctorId: z.string().min(1, 'appointments:book.errors.doctor'),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'appointments:book.errors.day'),
  startsAt: z.string().min(1, 'appointments:book.errors.slot'),
  reason: z.string().max(MAX_REASON).regex(PLAIN_LINES, 'validation.plain_text'),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export type BookingValues = z.infer<typeof bookingSchema>;

/** A calendar day this many days from another, counted at UTC noon so no day is skipped. */
export function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/** The days a booking can be made on: today at the hospital to `BOOK_AHEAD_DAYS` ahead. */
export const bookableDays = (today: string) => ({
  first: today,
  last: shiftDay(today, BOOK_AHEAD_DAYS),
});

/**
 * The booking form for a hospital's today. A typed or pasted day is not held to the date input's
 * `min` and `max`, so the range is checked here too.
 */
export function bookingSchemaFor(today: string) {
  const { first, last } = bookableDays(today);
  return bookingSchema.refine((values) => values.day >= first && values.day <= last, {
    path: ['day'],
    message: 'appointments:book.errors.dayRange',
  });
}
