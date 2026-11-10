import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import type { OtRoom, OtRoomPage, Surgery, SurgeryPage, SurgeryStatus } from './types';

export const PAGE_SIZE = 100;
export const STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly SurgeryStatus[];

/** The moves a person may make from a status, as the server's table allows them. */
export function allowedMoves(status: SurgeryStatus) {
  return {
    reschedule: status === 'scheduled',
    cancel: status === 'scheduled',
    start: status === 'scheduled',
    complete: status === 'in_progress',
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const when = {
  day: z.string().regex(DAY, 'validation.required'),
  startTime: z.string().regex(TIME, 'validation.required'),
  endTime: z.string().regex(TIME, 'validation.required'),
};
/** Ends after it starts on the same day. */
const ordered = (value: { startTime: string; endTime: string }) => value.endTime > value.startTime;
const orderedIssue = { message: 'validation.end_after_start', path: ['endTime'] };

export const bookFormSchema = z
  .object({
    roomId: z.string().min(1, 'validation.required'),
    surgeonId: z.string().min(1, 'validation.required'),
    procedure: z
      .string()
      .trim()
      .min(1, 'validation.required')
      .max(200, 'validation.invalid_value')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    notes: z
      .string()
      .trim()
      .max(500, 'validation.invalid_value')
      .regex(PLAIN_TEXT, 'validation.plain_text'),
    ...when,
  })
  .refine(ordered, orderedIssue);
export type BookFormValues = z.infer<typeof bookFormSchema>;

export const rescheduleFormSchema = z
  .object({
    roomId: z.string().min(1, 'validation.required'),
    surgeonId: z.string().min(1, 'validation.required'),
    ...when,
  })
  .refine(ordered, orderedIssue);
export type RescheduleFormValues = z.infer<typeof rescheduleFormSchema>;

export const reasonFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(300, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type ReasonFormValues = z.infer<typeof reasonFormSchema>;

export const roomFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(80, 'validation.invalid_value')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
});
export type RoomFormValues = z.infer<typeof roomFormSchema>;

export const roomSchema: z.ZodType<OtRoom> = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  archived: z.boolean(),
  version: z.number().int().min(1),
});
export const roomPageSchema: z.ZodType<OtRoomPage> = z.object({
  items: z.array(roomSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

export const surgerySchema: z.ZodType<Surgery> = z.object({
  id: z.string(),
  tenantId: z.string(),
  roomId: z.string(),
  surgeonId: z.string(),
  patientId: z.string(),
  serviceId: z.string().optional(),
  procedure: z.string(),
  notes: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(STATUSES),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  version: z.number().int().min(1),
});
export const surgeryPageSchema: z.ZodType<SurgeryPage> = z.object({
  items: z.array(surgerySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});
