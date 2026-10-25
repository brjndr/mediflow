import { api, requireData } from '@/shared/api';
import {
  labOrderResultsSchema,
  labResultSchema,
  labSampleSchema,
  labWorkItemPageSchema,
} from './schemas';
import type {
  LabOrderResults,
  LabResult,
  LabResultAmend,
  LabResultEntry,
  LabSample,
  LabSampleReject,
  LabStage,
  LabWorkItemPage,
  OrderPriority,
} from './types';

// Every address holds ids, a stage and a priority only: nothing about the patient is in a URL.
// Every POST carries an idempotency key, which the API requires.

export interface WorklistFilters {
  stage: LabStage;
  priority: OrderPriority | '';
}

/**
 * The hospital's lab orders at one stage: open ones stat first, the oldest first within a
 * priority; completed ones the newest completed first.
 */
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

/** The results of a lab order, with what is resulted and the patient's ranges (#91). */
export async function fetchOrderResults(
  orderId: string,
  signal?: AbortSignal,
): Promise<LabOrderResults> {
  const result = await api.GET('/lab/orders/{orderId}/results', {
    params: { path: { orderId } },
    signal,
  });
  return labOrderResultsSchema.parse(requireData(result));
}

export async function enterResults(
  sampleId: string,
  results: LabResultEntry[],
  idempotencyKey: string,
): Promise<LabOrderResults> {
  const result = await api.POST('/lab/samples/{sampleId}/results', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
    body: { results },
  });
  return labOrderResultsSchema.parse(requireData(result));
}

export async function verifyResults(
  sampleId: string,
  resultIds: string[],
  idempotencyKey: string,
): Promise<LabOrderResults> {
  const result = await api.POST('/lab/samples/{sampleId}/verify', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
    body: { resultIds },
  });
  return labOrderResultsSchema.parse(requireData(result));
}

export async function amendResult(
  resultId: string,
  body: LabResultAmend,
  idempotencyKey: string,
): Promise<LabResult> {
  const result = await api.POST('/lab/results/{resultId}/amend', {
    params: { path: { resultId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return labResultSchema.parse(requireData(result));
}
