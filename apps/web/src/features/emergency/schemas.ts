import { z } from 'zod';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ArrivalMode,
  DispositionType,
  EmergencyMlc,
  EmergencyNote,
  EmergencyNoteKind,
  EmergencyNotePage,
  EmergencyCase,
  EmergencyCasePage,
  EmergencyCaseStatus,
  EmergencySex,
  MlcCategory,
} from './types';

export const PAGE_SIZE = 50;
export const CATEGORIES = [1, 2, 3, 4, 5] as const;
export type Category = (typeof CATEGORIES)[number];
export const ARRIVAL_MODES = [
  'walk_in',
  'ambulance',
  'police',
  'referred',
] as const satisfies readonly ArrivalMode[];
export const SEXES = [
  'male',
  'female',
  'other',
  'unknown',
] as const satisfies readonly EmergencySex[];
export const DISPOSITIONS = [
  'discharge',
  'admit',
  'refer',
  'expired',
] as const satisfies readonly DispositionType[];
export const NOTE_KINDS = [
  'observation',
  'assessment',
] as const satisfies readonly EmergencyNoteKind[];
export const MLC_CATEGORIES = [
  'road_accident',
  'assault',
  'firearm_injury',
  'burns',
  'poisoning',
  'sexual_assault',
  'suspected_abuse',
  'suspicious_death',
  'other',
] as const satisfies readonly MlcCategory[];
export const NOTE_MAX = 2000;
export const DISPOSITION_NOTE_MAX = 500;
export const STATUSES = [
  'waiting',
  'in_treatment',
  'disposed',
] as const satisfies readonly EmergencyCaseStatus[];

/**
 * How long a patient of a category may wait before being seen, in minutes (the common
 * five-level scale: immediate, 10, 30, 60 and 120). A fixed default; a hospital's own targets
 * are a setting for later (see this folder's CLAUDE.md).
 */
export const TARGET_MINUTES: Record<Category, number> = { 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 };

/** Whole minutes from `since` to `now`, never negative. */
export function minutesSince(since: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
}

/** Whether a waiting patient has passed the target of their category. */
export function isOverdue(row: EmergencyCase, now: number): boolean {
  if (row.status !== 'waiting' || row.category === undefined) return false;
  return minutesSince(row.arrivedAt, now) > TARGET_MINUTES[row.category as Category];
}

const plain = (max: number) =>
  z.string().trim().max(max, 'validation.invalid_value').regex(PLAIN_TEXT, 'validation.plain_text');

export const registerFormSchema = z.object({
  alias: plain(120),
  sex: z.enum(SEXES),
  approximateAge: z
    .string()
    .trim()
    .regex(/^\d{0,3}$/, 'validation.invalid_value')
    .refine((value) => value === '' || Number(value) <= 130, 'validation.invalid_value'),
  complaint: plain(300).min(1, 'validation.required'),
  arrivalMode: z.enum(ARRIVAL_MODES),
  /** Empty while not yet triaged. */
  category: z.enum(['', '1', '2', '3', '4', '5']),
});
export type RegisterFormValues = z.infer<typeof registerFormSchema>;

const category = z.number().int().min(1).max(5);
export const caseSchema: z.ZodType<EmergencyCase> = z.object({
  id: z.string(),
  tenantId: z.string(),
  tempId: z.string(),
  patientId: z.string().optional(),
  alias: z.string().optional(),
  sex: z.enum(SEXES),
  approximateAge: z.number().int().optional(),
  complaint: z.string(),
  arrivalMode: z.enum(ARRIVAL_MODES),
  category: category.optional(),
  status: z.enum(STATUSES),
  arrivedAt: z.string(),
  triagedAt: z.string().optional(),
  identifiedAt: z.string().optional(),
  encounterId: z.string().optional(),
  disposition: z.enum(DISPOSITIONS).optional(),
  disposedAt: z.string().optional(),
  dispositionNote: z.string().optional(),
  destination: z.string().optional(),
  deathAt: z.string().optional(),
  admissionId: z.string().optional(),
  medicoLegal: z.boolean(),
  version: z.number().int().min(1),
});
export const casePageSchema: z.ZodType<EmergencyCasePage> = z.object({
  items: z.array(caseSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const noteSchema: z.ZodType<EmergencyNote> = z.object({
  id: z.string(),
  caseId: z.string(),
  kind: z.enum(NOTE_KINDS),
  body: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
export const notePageSchema: z.ZodType<EmergencyNotePage> = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
});

export const mlcSchema: z.ZodType<EmergencyMlc> = z.object({
  caseId: z.string(),
  revision: z.number().int().min(1),
  category: z.enum(MLC_CATEGORIES),
  narrative: z.string(),
  broughtBy: z.string().optional(),
  policeInformed: z.boolean(),
  policeStation: z.string().optional(),
  policeReference: z.string().optional(),
  recordedByName: z.string(),
  recordedAt: z.string(),
});

export const mlcHistorySchema = z.object({ items: z.array(mlcSchema) });

export const mlcFormSchema = z
  .object({
    category: z.enum(MLC_CATEGORIES),
    narrative: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(2000, 'validation.invalid_value')
      .regex(PLAIN_LINES, 'validation.plain_text'),
    broughtBy: plain(120),
    policeInformed: z.boolean(),
    policeStation: plain(120),
    policeReference: plain(60),
  })
  .superRefine((value, context) => {
    if (value.policeInformed && value.policeStation === '') {
      context.addIssue({ code: 'custom', path: ['policeStation'], message: 'validation.required' });
    }
  });
export type MlcFormValues = z.infer<typeof mlcFormSchema>;

export const noteFormSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  body: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(NOTE_MAX, 'validation.invalid_value')
    .regex(PLAIN_LINES, 'validation.plain_text'),
});
export type NoteFormValues = z.infer<typeof noteFormSchema>;

export const dispositionFormSchema = z
  .object({
    type: z.enum(DISPOSITIONS),
    note: z
      .string()
      .trim()
      .max(DISPOSITION_NOTE_MAX, 'validation.invalid_value')
      .regex(PLAIN_LINES, 'validation.plain_text'),
    destination: plain(120),
    /** To admit: the admitting doctor; empty is the caller's own profile. */
    doctorId: z.string().max(64),
    /** A local date and time, as a datetime-local field gives it. */
    deathAt: z.string(),
  })
  .superRefine((value, context) => {
    if (value.type === 'refer' && value.destination === '') {
      context.addIssue({ code: 'custom', path: ['destination'], message: 'validation.required' });
    }
    // Not in the future is the server's to say, on the hospital's clock.
    if (value.type === 'expired' && value.deathAt === '') {
      context.addIssue({ code: 'custom', path: ['deathAt'], message: 'validation.required' });
    }
  });
export type DispositionFormValues = z.infer<typeof dispositionFormSchema>;
