import { api, isApiError, requireData } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import { imagingReportSchema, imagingStudySchema, imagingWorkItemPageSchema } from './schemas';
import type {
  AddendumReason,
  ImagingReport,
  ImagingReportDraft,
  ImagingModality,
  ImagingStage,
  ImagingStudy,
  ImagingWorkItemPage,
  OrderPriority,
} from './types';

// Every address holds ids, a stage, a modality and a priority only: nothing about the patient is
// in a URL. Every POST carries an idempotency key, which the API requires.

export interface WorklistFilters {
  stage: ImagingStage;
  modality: ImagingModality | '';
  priority: OrderPriority | '';
}

/**
 * The hospital's imaging orders at one stage: to schedule stat first, the oldest first within a
 * priority; scheduled by slot, the soonest first; performed the longest waiting first.
 */
export async function fetchWorklist(
  {
    stage,
    modality,
    priority,
    cursor,
    limit,
  }: WorklistFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ImagingWorkItemPage> {
  const result = await api.GET('/radiology/worklist', {
    params: {
      query: {
        stage,
        modality: modality || undefined,
        priority: priority || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return imagingWorkItemPageSchema.parse(requireData(result));
}

/** Schedules the study of an order, or moves it: the study's version once it has one. */
export async function scheduleStudy(
  orderId: string,
  body: { scheduledAt: string; version?: number },
  idempotencyKey: string,
): Promise<ImagingStudy> {
  const result = await api.POST('/radiology/orders/{orderId}/schedule', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return imagingStudySchema.parse(requireData(result));
}

export async function unscheduleStudy(
  orderId: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<ImagingStudy> {
  const result = await api.POST('/radiology/orders/{orderId}/unschedule', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return imagingStudySchema.parse(requireData(result));
}

export async function performStudy(
  orderId: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<ImagingStudy> {
  const result = await api.POST('/radiology/orders/{orderId}/perform', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return imagingStudySchema.parse(requireData(result));
}

/** The report of an order's study, or null while it has none (404 `report_not_found`). */
export async function fetchReport(
  orderId: string,
  signal?: AbortSignal,
): Promise<ImagingReport | null> {
  try {
    const result = await api.GET('/radiology/orders/{orderId}/report', {
      params: { path: { orderId } },
      signal,
    });
    return imagingReportSchema.parse(requireData(result));
  } catch (error) {
    if (isApiError(error) && error.serverCode === 'report_not_found') return null;
    throw error;
  }
}

/** Saves the whole draft: from the report's version once it has one. */
export async function saveReport(
  orderId: string,
  body: ImagingReportDraft,
  idempotencyKey: string,
): Promise<ImagingReport> {
  const result = await api.PUT('/radiology/orders/{orderId}/report', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return imagingReportSchema.parse(requireData(result));
}

/** Signs the draft at its version: it never changes after, and its order is completed. */
export async function signReport(
  orderId: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<ImagingReport> {
  const result = await api.POST('/radiology/orders/{orderId}/report/sign', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return imagingReportSchema.parse(requireData(result));
}

/** Adds a signed addendum to a signed report. */
export async function addAddendum(
  orderId: string,
  body: { body: RichTextDocument; reason: AddendumReason },
  idempotencyKey: string,
): Promise<ImagingReport> {
  const result = await api.POST('/radiology/orders/{orderId}/report/addenda', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    body: { body: body.body as unknown as Record<string, unknown>, reason: body.reason },
  });
  return imagingReportSchema.parse(requireData(result));
}
