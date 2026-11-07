import { api, requireData } from '@/shared/api';
import {
  codingItemPageSchema,
  codingItemSchema,
  incompleteRecordPageSchema,
  recordRequestPageSchema,
  recordRequestSchema,
} from './schemas';
import type {
  CodingItem,
  CodingItemPage,
  CodingState,
  EncounterKind,
  IncompleteRecordPage,
  RecordGap,
  RecordRequest,
  RecordRequestClose,
  RecordRequestCreate,
  RecordRequestPage,
  RecordRequestState,
} from './types';

// Addresses hold ids, a state, a kind and a page cursor only: a name, a purpose or a diagnosis
// is never in a URL. Every POST carries an idempotency key.

export async function fetchIncompleteRecords(
  {
    gap,
    kind,
    cursor,
    limit,
  }: { gap: RecordGap | ''; kind: EncounterKind | ''; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<IncompleteRecordPage> {
  const result = await api.GET('/records/incomplete', {
    params: { query: { gap: gap || undefined, kind: kind || undefined, cursor, limit } },
    signal,
  });
  return incompleteRecordPageSchema.parse(requireData(result));
}

export async function fetchCodingQueue(
  { state, cursor, limit }: { state: CodingState; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CodingItemPage> {
  const result = await api.GET('/records/coding-queue', {
    params: { query: { state, cursor, limit } },
    signal,
  });
  return codingItemPageSchema.parse(requireData(result));
}

export async function codeDiagnosis(
  diagnosisId: string,
  body: { codeId: string; version: number },
  idempotencyKey: string,
): Promise<CodingItem> {
  const result = await api.POST('/records/coding-queue/{diagnosisId}/code', {
    params: { path: { diagnosisId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return codingItemSchema.parse(requireData(result));
}

export async function fetchRecordRequests(
  { state, cursor, limit }: { state: RecordRequestState | ''; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<RecordRequestPage> {
  const result = await api.GET('/record-requests', {
    params: { query: { state: state || undefined, cursor, limit } },
    signal,
  });
  return recordRequestPageSchema.parse(requireData(result));
}

export async function createRecordRequest(
  body: RecordRequestCreate,
  idempotencyKey: string,
): Promise<RecordRequest> {
  const result = await api.POST('/record-requests', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return recordRequestSchema.parse(requireData(result));
}

export async function closeRecordRequest(
  requestId: string,
  body: RecordRequestClose,
  idempotencyKey: string,
): Promise<RecordRequest> {
  const result = await api.POST('/record-requests/{requestId}/close', {
    params: { path: { requestId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return recordRequestSchema.parse(requireData(result));
}
