import { api, requireData } from '@/shared/api';
import {
  duplicateMatchesSchema,
  patientMergeListSchema,
  patientMergePreviewSchema,
  patientMergeSchema,
  patientPageSchema,
  patientRecordSchema,
} from './schemas';
import type {
  PatientCreate,
  PatientDuplicateMatches,
  PatientDuplicateQuery,
  PatientMerge,
  PatientMergeCreate,
  PatientMergePreview,
  PatientPage,
  PatientRecord,
  PatientSort,
  PatientUpdate,
} from './types';

export interface PatientListQuery {
  q?: string;
  cursor?: string;
  limit: number;
  sort?: PatientSort;
  /** Only the records merged into another (#604), each with the record to use instead. */
  mergedAway?: boolean;
}

/**
 * Listing is a POST because the search text can be a name, phone number or MRN, and those must
 * never appear in a URL (logs, history, proxies). The request only reads data.
 */
export async function fetchPatients(
  { q, cursor, limit, sort, mergedAway }: PatientListQuery,
  signal?: AbortSignal,
): Promise<PatientPage> {
  const result = await api.POST('/patients/search', {
    body: { q: q || undefined, cursor, limit, sort, mergedAway: mergedAway || undefined },
    signal,
  });
  return patientPageSchema.parse(requireData(result));
}

/** Identifying details go in the body, never in a URL. */
export async function checkDuplicates(
  query: PatientDuplicateQuery,
  signal?: AbortSignal,
): Promise<PatientDuplicateMatches> {
  const result = await api.POST('/patients/duplicate-check', { body: query, signal });
  return duplicateMatchesSchema.parse(requireData(result));
}

/** The idempotency key makes a retry or a double click return the first result, not a copy. */
export async function createPatient(
  body: PatientCreate,
  idempotencyKey: string,
): Promise<PatientRecord> {
  const result = await api.POST('/patients', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  const data = requireData(result);
  // A repeat of a request the server already carried out is answered with the new record's id
  // only (the server keeps no copy of patient data to replay), so the record is read afresh.
  if (result.response.headers.get('idempotent-replayed') === 'true') {
    return fetchPatient(data.id);
  }
  return patientRecordSchema.parse(data);
}

/** One patient's registration details. */
export async function fetchPatient(id: string, signal?: AbortSignal): Promise<PatientRecord> {
  const result = await api.GET('/patients/{id}', { params: { path: { id } }, signal });
  return patientRecordSchema.parse(requireData(result));
}

/**
 * Changes a patient's registration details. `expectedVersion` is the version the edit was made
 * from: if someone else has changed the record since, the server refuses with a conflict.
 */
export async function updatePatient(id: string, body: PatientUpdate): Promise<PatientRecord> {
  const result = await api.PATCH('/patients/{id}', { params: { path: { id } }, body });
  return patientRecordSchema.parse(requireData(result));
}

/**
 * Merges the record named in the body into `targetId`, which stays (#558). Both versions are the
 * ones read. The key makes a retry or a double click return the first result.
 */
export async function mergePatients(
  targetId: string,
  body: PatientMergeCreate,
  idempotencyKey: string,
): Promise<PatientMerge> {
  const result = await api.POST('/patients/{patientId}/merge', {
    params: { path: { patientId: targetId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return patientMergeSchema.parse(requireData(result));
}

/** What merging `sourceId` into `targetId` would move, by module. Reads only (#603). */
export async function fetchMergePreview(
  targetId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<PatientMergePreview> {
  const result = await api.GET('/patients/{patientId}/merge-preview', {
    params: { path: { patientId: targetId }, query: { source: sourceId } },
    signal,
  });
  return patientMergePreviewSchema.parse(requireData(result));
}

/** The records merged into this one, newest first (at most 100, no next page). */
export async function fetchPatientMerges(
  patientId: string,
  signal?: AbortSignal,
): Promise<PatientMerge[]> {
  const result = await api.GET('/patients/{patientId}/merges', {
    params: { path: { patientId } },
    signal,
  });
  return patientMergeListSchema.parse(requireData(result)).items;
}
