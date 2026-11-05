import { api, requireData } from '@/shared/api';
import { hospitalPageSchema, hospitalSchema } from './schemas';
import type { Hospital, HospitalCreate, HospitalPage, HospitalStatus } from './types';

export async function fetchHospitals(
  {
    cursor,
    limit,
    status,
    q,
  }: { cursor?: string; limit: number; status?: HospitalStatus; q?: string },
  signal?: AbortSignal,
): Promise<HospitalPage> {
  const result = await api.GET('/platform/hospitals', {
    params: { query: { cursor, limit, status, q } },
    signal,
  });
  return hospitalPageSchema.parse(requireData(result));
}

/** The key makes a repeat of the same request (a double click, a retry) create one hospital. */
export async function createHospital(
  body: HospitalCreate,
  idempotencyKey: string,
): Promise<Hospital> {
  const result = await api.POST('/platform/hospitals', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return hospitalSchema.parse(requireData(result));
}
