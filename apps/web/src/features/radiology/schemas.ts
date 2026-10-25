import { z } from 'zod';
import { nextDay } from '@/shared/utils/timezone';
import type {
  ImagingModality,
  ImagingStage,
  ImagingStudy,
  ImagingWorkItem,
  ImagingWorkItemPage,
  OrderPriority,
} from './types';

export const IMAGING_STAGES = [
  'to_schedule',
  'scheduled',
  'performed',
] as const satisfies readonly ImagingStage[];

export const MODALITIES = [
  'xray',
  'ct',
  'mri',
  'ultrasound',
  'mammography',
  'fluoroscopy',
  'nuclear',
  'other',
] as const satisfies readonly ImagingModality[];

/** Stat first: the order the worklist is sorted in. */
export const PRIORITIES = ['stat', 'urgent', 'routine'] as const satisfies readonly OrderPriority[];

const ORDER_STATUSES = ['placed', 'accepted', 'in_progress', 'completed', 'cancelled'] as const;

/** The API's slot: a study starts on a 15-minute step, up to 90 days ahead. */
export const SLOT_MINUTES = 15;
export const SCHEDULE_DAYS_AHEAD = 90;

/** Every start time of a day at the hospital, `HH:mm`, on the slot steps. */
export const SLOT_TIMES: readonly string[] = Array.from(
  { length: (24 * 60) / SLOT_MINUTES },
  (_, index) => {
    const minutes = index * SLOT_MINUTES;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  },
);

// Responses are validated where they enter the app, so screens can trust their shape.

export const imagingStudySchema: z.ZodType<ImagingStudy> = z.object({
  id: z.string(),
  tenantId: z.string(),
  orderId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  modality: z.enum(MODALITIES),
  scheduledAt: z.string().optional(),
  scheduledByName: z.string().optional(),
  performedAt: z.string().optional(),
  performedByName: z.string().optional(),
  version: z.number().int(),
});

export const imagingWorkItemSchema: z.ZodType<ImagingWorkItem> = z.object({
  orderId: z.string(),
  tenantId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  patientMrn: z.string(),
  patientDob: z.string().optional(),
  serviceId: z.string(),
  itemCode: z.string().optional(),
  itemName: z.string(),
  modality: z.enum(MODALITIES),
  priority: z.enum(PRIORITIES),
  instructions: z.string().optional(),
  placedAt: z.string(),
  orderedByName: z.string(),
  orderStatus: z.enum(ORDER_STATUSES),
  stage: z.enum(IMAGING_STAGES),
  study: imagingStudySchema.optional(),
});

export const imagingWorkItemPageSchema: z.ZodType<ImagingWorkItemPage> = z.object({
  items: z.array(imagingWorkItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().optional(),
});

/** The last day a study may be scheduled on, from today at the hospital. */
export function lastScheduleDay(today: string): string {
  let day = today;
  for (let n = 0; n < SCHEDULE_DAYS_AHEAD; n += 1) day = nextDay(day);
  return day;
}

/**
 * Scheduling a study: a day at the hospital, today to 90 days ahead, and a start time on a slot
 * step. Whether the time has passed is the server's to say (422 `outside_window`), as it is the
 * clock that decides. Messages are translation keys.
 */
export const scheduleSchemaFor = (today: string) => {
  const last = lastScheduleDay(today);
  return z.object({
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.required')
      .refine((day) => day >= today && day <= last, 'radiology:schedule.dayOutside'),
    time: z.string().refine((time) => SLOT_TIMES.includes(time), 'validation.required'),
  });
};
export type ScheduleValues = z.input<ReturnType<typeof scheduleSchemaFor>>;
export type ScheduleOutput = z.output<ReturnType<typeof scheduleSchemaFor>>;
