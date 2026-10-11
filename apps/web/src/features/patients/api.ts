import { api, requireData } from '@/shared/api';
import { patientPageSchema } from './schemas';
import type { PatientPage, PatientSort } from './types';

export interface PatientListQuery {
  q?: string;
  cursor?: string;
  limit: number;
  sort?: PatientSort;
}

/** The search text travels in the query string of this request only, never in the app address. */
export async function fetchPatients(
  { q, cursor, limit, sort }: PatientListQuery,
  signal?: AbortSignal,
): Promise<PatientPage> {
  const result = await api.GET('/patients', {
    params: { query: { q: q || undefined, cursor, limit, sort } },
    signal,
  });
  return patientPageSchema.parse(requireData(result));
}
