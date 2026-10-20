import { z } from 'zod';
import type {
  Doctor,
  DoctorAvailability,
  DoctorCandidatePage,
  DoctorPage,
  DoctorSession,
  Weekday,
} from './types';
import { PLAIN_TEXT } from '@/shared/utils/text';

/** Monday first, as a hospital's week is written. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Responses are validated where they enter the app, so screens can trust their shape. */
export const doctorSchema: z.ZodType<Doctor> = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  name: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  specialization: z.string(),
  registrationNumber: z.string().optional(),
  qualifications: z.string().optional(),
  registrationCouncil: z.string().optional(),
  consultationMinutes: z.number().int(),
  active: z.boolean(),
  version: z.number().int().min(1),
});

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export const doctorPageSchema: z.ZodType<DoctorPage> = page(doctorSchema);

export const candidatePageSchema: z.ZodType<DoctorCandidatePage> = page(
  z.object({ userId: z.string(), name: z.string(), email: z.string() }),
);

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const sessionSchema: z.ZodType<DoctorSession> = z.object({
  day: z.enum(WEEKDAYS),
  start: z.string().regex(TIME),
  end: z.string().regex(TIME),
});

export const availabilitySchema: z.ZodType<DoctorAvailability> = z.object({
  doctorId: z.string(),
  sessions: z.array(sessionSchema),
  version: z.number().int().min(1),
});

export const SPECIALIZATION_MAX = 100;
export const REGISTRATION_MAX = 50;
export const QUALIFICATIONS_MAX = 200;
export const COUNCIL_MAX = 100;
/** The appointment lengths offered. A profile may hold another one, which the form keeps. */
export const CONSULTATION_MINUTES = ['5', '10', '15', '20', '30', '45', '60'] as const;

/** The profile form. Messages are translation keys in core `common`. */
export const doctorFormSchema = z.object({
  departmentId: z.string().min(1, 'validation.required'),
  specialization: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(SPECIALIZATION_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  registrationNumber: z
    .string()
    .trim()
    .max(REGISTRATION_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  qualifications: z
    .string()
    .trim()
    .max(QUALIFICATIONS_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  registrationCouncil: z
    .string()
    .trim()
    .max(COUNCIL_MAX)
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  consultationMinutes: z.string().regex(/^\d{1,3}$/, 'validation.required'),
});
export type DoctorFormValues = z.infer<typeof doctorFormSchema>;
export type DoctorField = keyof DoctorFormValues;

/** What is wrong with a day's hours, as a key of this feature's strings. */
export type HoursProblem =
  'hours.errors.incomplete' | 'hours.errors.order' | 'hours.errors.overlap';

/**
 * Checks the hours of each day: every session has both times, ends after it starts, and no two
 * of a day overlap. HH:MM strings compare correctly as text.
 */
export function hoursProblems(sessions: DoctorSession[]): Partial<Record<Weekday, HoursProblem>> {
  const problems: Partial<Record<Weekday, HoursProblem>> = {};
  for (const day of WEEKDAYS) {
    const ofDay = sessions
      .filter((session) => session.day === day)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (ofDay.some((session) => !TIME.test(session.start) || !TIME.test(session.end))) {
      problems[day] = 'hours.errors.incomplete';
    } else if (ofDay.some((session) => session.end <= session.start)) {
      problems[day] = 'hours.errors.order';
    } else if (ofDay.some((session, index) => index > 0 && session.start < ofDay[index - 1]!.end)) {
      problems[day] = 'hours.errors.overlap';
    }
  }
  return problems;
}
