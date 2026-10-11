import { api, requireData } from '@/shared/api';
import { duplicateMatchesSchema, patientPageSchema, patientRecordSchema } from './schemas';
import type {
  PatientCreate,
  PatientDuplicateMatches,
  PatientDuplicateQuery,
  PatientPage,
  PatientRecord,
  PatientSort,
} from './types';

export interface PatientListQuery {
  q?: string;
  cursor?: string;
  limit: number;
  sort?: PatientSort;
}

/**
 * Listing is a POST because the search text can be a name, phone number or MRN, and those must
 * never appear in a URL (logs, history, proxies). The request only reads data.
 */
export async function fetchPatients(
  { q, cursor, limit, sort }: PatientListQuery,
  signal?: AbortSignal,
): Promise<PatientPage> {
  const result = await api.POST('/patients/search', {
    body: { q: q || undefined, cursor, limit, sort },
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
  return patientRecordSchema.parse(requireData(result));
}
