import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type {
  CopyWeekResult,
  LeaveStatus,
  RosterLeave,
  RosterLeavePage,
  RosterShift,
  RosterShiftPage,
  ShiftKind,
  ShiftSwapResult,
  ShiftTemplate,
  ShiftTemplatePage,
} from './types';

export const ROSTER_PAGE_SIZE = 100;
export const SHIFT_KINDS = [
  'morning',
  'evening',
  'night',
  'day',
  'on_call',
] as const satisfies readonly ShiftKind[];

/** Rest between two shifts of one person below which the roster says so (hours). */
export const MIN_REST_HOURS = 8;

/**
 * Shift templates: the hours a kind of shift usually runs, on the hospital's clock. They fill the
 * form; the server only ever sees the start and end that were chosen. A hospital's own templates
 * need a settings record in the API (proposed follow-up).
 */
export const SHIFT_TEMPLATES: Record<ShiftKind, { start: string; end: string }> = {
  morning: { start: '07:00', end: '15:00' },
  evening: { start: '15:00', end: '23:00' },
  night: { start: '23:00', end: '07:00' },
  day: { start: '08:00', end: '20:00' },
  on_call: { start: '20:00', end: '08:00' },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const shiftFormSchema = z
  .object({
    templateId: z.string(),
    userId: z.string().min(1, 'validation.required'),
    departmentId: z.string(),
    shiftKind: z.enum(SHIFT_KINDS),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.required'),
    startTime: z.string().regex(TIME, 'validation.required'),
    endTime: z.string().regex(TIME, 'validation.required'),
  })
  .refine((v) => v.startTime !== v.endTime, {
    path: ['endTime'],
    message: 'validation.invalid_value',
  });
export type ShiftFormValues = z.infer<typeof shiftFormSchema>;

export const rosterShiftSchema: z.ZodType<RosterShift> = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  userName: z.string(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  shiftKind: z.enum(SHIFT_KINDS),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['scheduled', 'cancelled']),
  version: z.number().int(),
});

export const rosterShiftPageSchema: z.ZodType<RosterShiftPage> = z.object({
  items: z.array(rosterShiftSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const LEAVE_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'cancelled',
] as const satisfies readonly LeaveStatus[];

export const rosterLeaveSchema: z.ZodType<RosterLeave> = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  userName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(LEAVE_STATUSES),
  decidedByName: z.string().optional(),
  decidedAt: z.string().optional(),
  version: z.number().int(),
});

export const rosterLeavePageSchema: z.ZodType<RosterLeavePage> = z.object({
  items: z.array(rosterLeaveSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days on the hospital's clock: the first and the last day away, both counted. */
export const leaveFormSchema = z
  .object({
    firstDay: z.string().regex(DAY, 'validation.required'),
    lastDay: z.string().regex(DAY, 'validation.required'),
  })
  .refine((v) => v.lastDay >= v.firstDay, {
    path: ['lastDay'],
    message: 'validation.invalid_value',
  });
export type LeaveFormValues = z.infer<typeof leaveFormSchema>;

export const shiftTemplateSchema: z.ZodType<ShiftTemplate> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  shiftKind: z.enum(SHIFT_KINDS),
  startTime: z.string(),
  endTime: z.string(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  active: z.boolean(),
  version: z.number().int(),
});

export const shiftTemplatePageSchema: z.ZodType<ShiftTemplatePage> = z.object({
  items: z.array(shiftTemplateSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const templateFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(60)
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    shiftKind: z.enum(SHIFT_KINDS),
    departmentId: z.string(),
    startTime: z.string().regex(TIME, 'validation.required'),
    endTime: z.string().regex(TIME, 'validation.required'),
  })
  .refine((v) => v.startTime !== v.endTime, {
    path: ['endTime'],
    message: 'validation.invalid_value',
  });
export type TemplateFormValues = z.infer<typeof templateFormSchema>;

export const MAX_COPY_WEEKS = 12;

export const copyWeekFormSchema = z.object({
  weeks: z
    .string()
    .regex(/^\d{1,2}$/, 'validation.invalid_value')
    .refine((v) => Number(v) >= 1 && Number(v) <= MAX_COPY_WEEKS, 'validation.invalid_value'),
});
export type CopyWeekFormValues = z.infer<typeof copyWeekFormSchema>;

export const copyWeekResultSchema: z.ZodType<CopyWeekResult> = z.object({
  copied: z.number().int(),
  skipped: z.array(
    z.object({
      shiftId: z.string(),
      userName: z.string(),
      startsAt: z.string(),
      reason: z.enum(['shift_overlap', 'on_leave']),
    }),
  ),
});

export const shiftSwapResultSchema: z.ZodType<ShiftSwapResult> = z.object({
  created: z.array(rosterShiftSchema),
});

export const swapFormSchema = z
  .object({
    mode: z.enum(['hand_over', 'exchange']),
    userId: z.string(),
    withShiftId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'hand_over' && v.userId === '') {
      ctx.addIssue({ code: 'custom', path: ['userId'], message: 'validation.required' });
    }
    if (v.mode === 'exchange' && v.withShiftId === '') {
      ctx.addIssue({ code: 'custom', path: ['withShiftId'], message: 'validation.required' });
    }
  });
export type SwapFormValues = z.infer<typeof swapFormSchema>;
