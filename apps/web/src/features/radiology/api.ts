import { api, requireData } from '@/shared/api';
import { imagingStudySchema, imagingWorkItemPageSchema } from './schemas';
import type {
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
