import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  ArrivalMode,
  EmergencyCase,
  EmergencyCasePage,
  EmergencyCaseStatus,
  EmergencySex,
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
  version: z.number().int().min(1),
});
export const casePageSchema: z.ZodType<EmergencyCasePage> = z.object({
  items: z.array(caseSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
