import { api, requireData } from '@/shared/api';
import { labSampleSchema, labWorkItemPageSchema } from './schemas';
import type { LabSample, LabSampleReject, LabStage, LabWorkItemPage, OrderPriority } from './types';

// Every address holds ids, a stage and a priority only: nothing about the patient is in a URL.
// Every POST carries an idempotency key, which the API requires.

export interface WorklistFilters {
  stage: LabStage;
  priority: OrderPriority | '';
}

/** The hospital's lab orders at one stage, stat first, the oldest first within a priority. */
export async function fetchWorklist(
  { stage, priority, cursor, limit }: WorklistFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<LabWorkItemPage> {
  const result = await api.GET('/lab/worklist', {
    params: { query: { stage, priority: priority || undefined, cursor, limit } },
    signal,
  });
  return labWorkItemPageSchema.parse(requireData(result));
}

export async function collectSample(orderId: string, idempotencyKey: string): Promise<LabSample> {
  const result = await api.POST('/lab/orders/{orderId}/samples', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
  });
  return labSampleSchema.parse(requireData(result));
}

export async function receiveSample(
  sampleId: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<LabSample> {
  const result = await api.POST('/lab/samples/{sampleId}/receive', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return labSampleSchema.parse(requireData(result));
}

export async function rejectSample(
  sampleId: string,
  body: LabSampleReject,
  idempotencyKey: string,
): Promise<LabSample> {
  const result = await api.POST('/lab/samples/{sampleId}/reject', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return labSampleSchema.parse(requireData(result));
}

/** Records a print of the label in the audit log; nothing prints until it is answered. */
export async function recordLabelPrint(sampleId: string, idempotencyKey: string) {
  await api.POST('/lab/samples/{sampleId}/print', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
  });
}
