import { api, requireData } from '@/shared/api';
import {
  labOrderResultsSchema,
  labResultPageSchema,
  labResultSchema,
  labSampleSchema,
  labWorkItemPageSchema,
} from './schemas';
import type {
  LabOrderResults,
  LabResult,
  LabResultAmend,
  LabResultEntry,
  LabResultPage,
  LabSample,
  LabSampleReject,
  LabSampleSendOut,
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

/** Sends a received sample to a partner laboratory (#94). */
export async function sendOutSample(
  sampleId: string,
  body: LabSampleSendOut,
  idempotencyKey: string,
): Promise<LabSample> {
  const result = await api.POST('/lab/samples/{sampleId}/send-out', {
    params: { path: { sampleId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return labSampleSchema.parse(requireData(result));
}

/** Records that the partner laboratory's report came back, so results can be entered (#94). */
export async function returnPartnerReport(
  sampleId: string,
  body: { version: number },
  idempotencyKey: string,
): Promise<LabSample> {
  const result = await api.POST('/lab/samples/{sampleId}/partner-report', {
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

/**
 * A patient's released results (#92), the newest collected first, narrowed to one test (its
 * trend) or one encounter. A POST: the patient and the test together say what was tested.
 */
export async function searchResults(
  body: {
    patientId: string;
    labTestId?: string;
    encounterId?: string;
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<LabResultPage> {
  const result = await api.POST('/lab/results/search', { body, signal });
  return labResultPageSchema.parse(requireData(result));
}

/** A doctor has seen a verified critical result (#92). */
export async function acknowledgeResult(
  resultId: string,
  idempotencyKey: string,
): Promise<LabResult> {
  const result = await api.POST('/lab/results/{resultId}/acknowledge', {
    params: { path: { resultId }, header: { 'idempotency-key': idempotencyKey } },
  });
  return labResultSchema.parse(requireData(result));
}

/** Records a print of the order's report in the audit log; nothing prints until it is answered. */
export async function recordReportPrint(
  orderId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  await api.POST('/lab/orders/{orderId}/print', {
    params: { path: { orderId }, header: { 'idempotency-key': idempotencyKey } },
    signal,
  });
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
