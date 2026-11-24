import { z } from 'zod';
import type { AuditEntry, AuditPage, ReportRun } from './types';

/** The API's limits (`apps/api/src/features/audit`): days in one search, and in one export. */
export const SEARCH_MAX_DAYS = 92;
export const EXPORT_MAX_DAYS = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

// A filter is a search term: it is tidied by the API and never refused for its characters.
const filterText = (max: number) => z.string().max(max, 'audit_log:form.errors.long');

/** What the filter form holds. Empty text means no filter. */
export const filterSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    actorId: z.string().max(64),
    entity: filterText(63),
    entityId: filterText(64),
    action: filterText(63),
    q: filterText(63),
  })
  .superRefine((values, ctx) => {
    const fromOk = isCalendarDay(values.from);
    const toOk = isCalendarDay(values.to);
    if (!fromOk)
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'audit_log:form.errors.day' });
    if (!toOk) ctx.addIssue({ code: 'custom', path: ['to'], message: 'audit_log:form.errors.day' });
    if (!fromOk || !toOk) return;
    if (values.to < values.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'audit_log:form.errors.order' });
    } else if (daysIncluded(values.from, values.to) > SEARCH_MAX_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'audit_log:form.errors.tooLong' });
    }
  });
export type FilterValues = z.infer<typeof filterSchema>;

export const auditEntrySchema: z.ZodType<AuditEntry> = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  detail: z.string().nullable(),
});

export const auditPageSchema: z.ZodType<AuditPage> = z.object({
  items: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
  total: z.number().optional(),
});

/** The export run, as far as this screen follows it. */
export const exportRunSchema: z.ZodType<ReportRun> = z.object({
  id: z.string(),
  kind: z.enum([
    'opd_census',
    'revenue',
    'doctor_activity',
    'lab_turnaround',
    'pharmacy_sales',
    'stock',
    'collections',
    'collections_by_close',
    'outstanding',
    'opd_hourly',
    'audit_log',
    'opd_progress',
  ]),
  from: z.string().nullable(),
  to: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  requestedBy: z.object({ id: z.string(), name: z.string() }),
  requestedAt: z.string(),
  finishedAt: z.string().optional(),
  expiresAt: z.string(),
  rowCount: z.number().optional(),
  failure: z.string().optional(),
  filters: z
    .object({
      actorId: z.string().optional(),
      actorName: z.string().optional(),
      entity: z.string().optional(),
      entityId: z.string().optional(),
      action: z.string().optional(),
      q: z.string().optional(),
    })
    .optional(),
});

export const exportPageSchema = z.object({
  items: z.array(exportRunSchema),
  nextCursor: z.string().nullable(),
});

export const downloadSchema = z.object({ url: z.string(), expiresAt: z.string() });

export const WORKING: readonly ReportRun['status'][] = ['queued', 'running'];
