import { api, requireData } from '@/shared/api';
import {
  codingItemPageSchema,
  correctionAmendmentPageSchema,
  correctionRequestPageSchema,
  correctionRequestSchema,
  codingItemSchema,
  incompleteRecordPageSchema,
  incompleteRecordSchema,
  recordRequestPageSchema,
  recordRequestSchema,
} from './schemas';
import type {
  CodingItem,
  CorrectionAmendmentPage,
  CorrectionTarget,
  CorrectionRequest,
  CorrectionRequestCreate,
  CorrectionRequestDecide,
  CorrectionRequestPage,
  CorrectionStatus,
  CodingItemPage,
  CodingState,
  EncounterKind,
  IncompleteRecord,
  IncompleteRecordAssign,
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

export async function assignIncompleteRecord(
  encounterId: string,
  body: IncompleteRecordAssign,
  idempotencyKey: string,
): Promise<IncompleteRecord> {
  const result = await api.POST('/records/incomplete/{encounterId}/assign', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return incompleteRecordSchema.parse(requireData(result));
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
  {
    state,
    patientId,
    cursor,
    limit,
  }: { state: RecordRequestState | ''; patientId?: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<RecordRequestPage> {
  const result = await api.GET('/record-requests', {
    params: { query: { state: state || undefined, patientId, cursor, limit } },
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

export async function fetchCorrectionRequests(
  {
    status,
    patientId,
    cursor,
    limit,
  }: { status: CorrectionStatus | ''; patientId?: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CorrectionRequestPage> {
  // The hospital's whole queue, or one patient's (the id is in the path, never a name).
  const query = { status: status || undefined, cursor, limit };
  const result = patientId
    ? await api.GET('/patients/{patientId}/correction-requests', {
        params: { path: { patientId }, query },
        signal,
      })
    : await api.GET('/correction-requests', { params: { query }, signal });
  return correctionRequestPageSchema.parse(requireData(result));
}

export async function requestCorrection(
  patientId: string,
  body: CorrectionRequestCreate,
  idempotencyKey: string,
): Promise<CorrectionRequest> {
  const result = await api.POST('/patients/{patientId}/correction-requests', {
    params: { path: { patientId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return correctionRequestSchema.parse(requireData(result));
}

export async function decideCorrection(
  requestId: string,
  decision: 'approve' | 'reject',
  body: CorrectionRequestDecide,
): Promise<CorrectionRequest> {
  const params = { path: { requestId } };
  const result =
    decision === 'approve'
      ? await api.POST('/correction-requests/{requestId}/approve', { params, body })
      : await api.POST('/correction-requests/{requestId}/reject', { params, body });
  return correctionRequestSchema.parse(requireData(result));
}

/** The amendments of a patient's record, or of one visit or document of it (ids in the address only). */
export async function fetchCorrectionAmendments(
  {
    patientId,
    target,
    cursor,
    limit,
  }: {
    patientId: string;
    target?: { kind: CorrectionTarget; id?: string };
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<CorrectionAmendmentPage> {
  const result = await api.GET('/patients/{patientId}/correction-amendments', {
    params: {
      path: { patientId },
      query: { targetKind: target?.kind, targetId: target?.id, cursor, limit },
    },
    signal,
  });
  return correctionAmendmentPageSchema.parse(requireData(result));
}
