import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type { FollowUp, FollowUpCreate, FollowUpPage, FollowUpState } from './types';

export const FOLLOW_UP_STATES = [
  'due',
  'booked',
  'attended',
  'cancelled',
] as const satisfies readonly FollowUpState[];

/** The API's limits (`apps/api/src/features/clinical/schemas.ts`). */
export const NOTE_MAX = 500;
export const REASON_MAX = 200;
/** A follow-up is due from today to this many days ahead at the hospital. */
export const DUE_DAYS_AHEAD = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Responses are validated where they enter the app, so screens can trust their shape.

export const followUpSchema: z.ZodType<FollowUp> = z.object({
  id: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  doctorId: z.string(),
  doctorName: z.string(),
  dueOn: z.string().regex(DAY),
  note: z.string().optional(),
  state: z.enum(FOLLOW_UP_STATES),
  appointmentId: z.string().optional(),
  appointmentStartsAt: z.string().optional(),
  createdAt: z.string(),
  createdByName: z.string(),
  bookedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  version: z.number().int(),
});

export const followUpPageSchema: z.ZodType<FollowUpPage> = z.object({
  items: z.array(followUpSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** A calendar day this many days from another, counted at UTC noon so no day is skipped. */
export function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/** A day that exists, as `YYYY-MM-DD`: the 31st of February has the shape but is no day. */
const isCalendarDay = (day: string) =>
  DAY.test(day) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * Setting a follow-up for a hospital's today: the day the patient should come back (today to a
 * year ahead, checked here too as a typed day gets past the date input's limits), to whom (the
 * encounter's doctor when none is chosen) and a note for whoever books it.
 */
export function followUpFormSchemaFor(today: string) {
  const last = shiftDay(today, DUE_DAYS_AHEAD);
  return z.object({
    dueOn: z
      .string()
      .refine(isCalendarDay, 'follow_ups:form.errors.day')
      .refine((day) => day >= today && day <= last, 'follow_ups:form.errors.dayRange'),
    doctorId: z.string(),
    note: z
      .string()
      .trim()
      .max(NOTE_MAX, 'validation.too_big')
      .regex(PLAIN_LINES, 'validation.plain_text'),
  });
}
export type FollowUpValues = z.input<ReturnType<typeof followUpFormSchemaFor>>;

export function toFollowUpCreate(
  values: z.output<ReturnType<typeof followUpFormSchemaFor>>,
): FollowUpCreate {
  return {
    dueOn: values.dueOn,
    ...(values.doctorId ? { doctorId: values.doctorId } : {}),
    ...(values.note ? { note: values.note } : {}),
  };
}

/** Booking: a doctor, a day of the booking window and one of the doctor's free times. */
export function bookFormSchemaFor(first: string, last: string) {
  return z.object({
    doctorId: z.string().min(1, 'follow_ups:book.errors.doctor'),
    day: z
      .string()
      .refine(isCalendarDay, 'follow_ups:form.errors.day')
      .refine((day) => day >= first && day <= last, 'follow_ups:book.errors.dayRange'),
    startsAt: z.string().min(1, 'follow_ups:book.errors.slot'),
  });
}
export type BookValues = z.infer<ReturnType<typeof bookFormSchemaFor>>;

/** Why a follow-up is cancelled: one line of plain text, required. */
export const cancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(REASON_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type CancelValues = z.infer<typeof cancelSchema>;
