import { api, requireData } from '@/shared/api';
import { patientPageSchema } from './schemas';
import type { PatientPage, PatientSort } from './types';

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
