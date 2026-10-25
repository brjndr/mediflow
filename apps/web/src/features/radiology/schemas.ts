import { z } from 'zod';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { nextDay } from '@/shared/utils/timezone';
import type {
  AddendumReason,
  ImagingReport,
  ImagingReportStatus,
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
  'reported',
] as const satisfies readonly ImagingStage[];

const REPORT_STATUSES = ['draft', 'signed'] as const satisfies readonly ImagingReportStatus[];

/** Why an addendum is added, from a list: never typed. */
export const ADDENDUM_REASONS = [
  'correction',
  'additional_finding',
  'clarification',
  'comparison',
  'other',
] as const satisfies readonly AddendumReason[];

/** The API's limits on links to images held elsewhere. */
export const MAX_LINKS = 10;
export const LINK_LABEL_MAX = 120;
export const LINK_URL_MAX = 2000;

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
  patientSex: z.string(),
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
  reportStatus: z.enum(REPORT_STATUSES).optional(),
  reportSignedAt: z.string().optional(),
  reportSignedByName: z.string().optional(),
});

const richText = z.record(z.string(), z.unknown());

export const imagingReportSchema: z.ZodType<ImagingReport> = z.object({
  id: z.string(),
  tenantId: z.string(),
  orderId: z.string(),
  studyId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  status: z.enum(REPORT_STATUSES),
  technique: richText,
  findings: richText,
  impression: richText,
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  templateId: z.string().optional(),
  templateVersion: z.number().int().optional(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedByName: z.string(),
  updatedAt: z.string(),
  signedByName: z.string().optional(),
  signedAt: z.string().optional(),
  addenda: z.array(
    z.object({
      id: z.string(),
      body: richText,
      reason: z.enum(ADDENDUM_REASONS),
      signedByName: z.string(),
      signedAt: z.string(),
    }),
  ),
  version: z.number().int(),
});

/**
 * A link to images held elsewhere: a label and an https address with no user name or password
 * and no parameter named as a secret, as the API takes it (400 `invalid_link` otherwise): a
 * signed report keeps it for ever. Messages are translation keys.
 */
export const linkSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(LINK_LABEL_MAX, 'validation.too_big')
    .regex(PLAIN_TEXT, 'validation.plain_text'),
  url: z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(LINK_URL_MAX, 'validation.too_big')
    .refine(isSafeLink, 'radiology:report.links.invalid'),
});
export type LinkValues = z.input<typeof linkSchema>;
export type LinkOutput = z.output<typeof linkSchema>;

/** A parameter name that says it carries a secret, as the API refuses it. */
const SECRET_PARAMETER = /token|sig|key|auth|pass|secret|credential|session/i;

function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value);
    const fragment = url.hash.slice(1);
    const names = [
      ...url.searchParams.keys(),
      ...(fragment.includes('=')
        ? new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1)).keys()
        : []),
    ];
    return (
      url.protocol === 'https:' &&
      url.hostname !== '' &&
      !url.username &&
      !url.password &&
      !names.some((name) => SECRET_PARAMETER.test(name))
    );
  } catch {
    return false;
  }
}

/** Why an addendum is added: chosen from the list. */
export const addendumSchema = z.object({
  reason: z.enum(ADDENDUM_REASONS, 'validation.required'),
});
export type AddendumValues = z.input<typeof addendumSchema>;
export type AddendumOutput = z.output<typeof addendumSchema>;

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
