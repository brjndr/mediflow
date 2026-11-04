import { z } from 'zod';
import type {
  ReportDownload,
  ReportKind,
  ReportLimits,
  ReportResult,
  ReportRun,
  ReportRunPage,
  ReportRunStatus,
} from './types';

export const REPORT_KINDS = [
  'opd_census',
  'revenue',
  'doctor_activity',
  'lab_turnaround',
  'pharmacy_sales',
  'stock',
] as const satisfies readonly ReportKind[];

/** A report that is a snapshot of now: it takes no days. */
export const SNAPSHOT_KINDS: readonly ReportKind[] = ['stock'];

/** The API's limits (`apps/api/src/features/reports`): days answered on the spot, and stored. */
export const SPOT_MAX_DAYS = 31;
export const STORED_MAX_DAYS = 366;

/** Runs a job is still working on: they are asked about until they end. */
export const WORKING: readonly ReportRunStatus[] = ['queued', 'running'];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const cell = z.union([z.string(), z.number(), z.null()]);

// Responses are validated where they enter the app, so screens can trust their shape.

export const reportResultSchema: z.ZodType<ReportResult> = z.object({
  kind: z.enum(REPORT_KINDS),
  from: z.string().nullable(),
  to: z.string().nullable(),
  currency: z.string(),
  generatedAt: z.string(),
  columns: z.array(
    z.object({ key: z.string(), type: z.enum(['text', 'date', 'integer', 'money', 'minutes']) }),
  ),
  rows: z.array(z.array(cell)),
  totals: z.array(cell),
});

export const reportRunSchema: z.ZodType<ReportRun> = z.object({
  id: z.string(),
  kind: z.enum(REPORT_KINDS),
  from: z.string().nullable(),
  to: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  requestedBy: z.object({ id: z.string(), name: z.string() }),
  requestedAt: z.string(),
  finishedAt: z.string().optional(),
  expiresAt: z.string(),
  rowCount: z.number().optional(),
  failure: z.string().optional(),
  result: reportResultSchema.optional(),
});

export const reportRunPageSchema: z.ZodType<ReportRunPage> = z.object({
  items: z.array(reportRunSchema),
  nextCursor: z.string().nullable(),
  total: z.number().optional(),
});

export const reportLimitsSchema: z.ZodType<ReportLimits> = z.object({
  maxConcurrent: z.number(),
  maxPerDay: z.number(),
  retentionDays: z.number(),
  active: z.number(),
  usedToday: z.number(),
});

export const reportDownloadSchema: z.ZodType<ReportDownload> = z.object({
  url: z.string(),
  expiresAt: z.string(),
});

/** A calendar day moved by a number of days, by the calendar and not the clock. */
export function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/** Whole days from one calendar day to another, both included. */
export function daysIncluded(from: string, to: string): number {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

const isCalendarDay = (day: string) =>
  DAY.test(day) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;

/** What the request form holds: a report and, for all but a snapshot, the days it covers. */
export const requestSchema = z
  .object({
    kind: z.enum(REPORT_KINDS, { message: 'reports:form.errors.kind' }),
    from: z.string(),
    to: z.string(),
  })
  .superRefine((values, ctx) => {
    if (SNAPSHOT_KINDS.includes(values.kind)) return;
    const fromOk = isCalendarDay(values.from);
    const toOk = isCalendarDay(values.to);
    if (!fromOk) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'reports:form.errors.day' });
    }
    if (!toOk) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'reports:form.errors.day' });
    }
    if (!fromOk || !toOk) return;
    if (values.to < values.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'reports:form.errors.order' });
    } else if (daysIncluded(values.from, values.to) > STORED_MAX_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'reports:form.errors.tooLong' });
    }
  });
export type RequestValues = z.infer<typeof requestSchema>;
