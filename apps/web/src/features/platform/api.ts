import { api, requireData } from '@/shared/api';
import { hospitalPageSchema, hospitalSchema } from './schemas';
import type {
  Hospital,
  HospitalCreate,
  HospitalLimitsUpdate,
  HospitalPage,
  HospitalStatus,
} from './types';

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

export async function fetchHospital(id: string, signal?: AbortSignal): Promise<Hospital> {
  const result = await api.GET('/platform/hospitals/{id}', { params: { path: { id } }, signal });
  return hospitalSchema.parse(requireData(result));
}

/** Switches modules on or off. Modules not named keep their setting. */
export async function setHospitalFeatures(
  id: string,
  features: { feature: string; enabled: boolean }[],
): Promise<Hospital> {
  const result = await api.PUT('/platform/hospitals/{id}/features', {
    params: { path: { id } },
    body: { features },
  });
  return hospitalSchema.parse(requireData(result));
}

/** Changes the fields named, from the `version` the edit started from. */
export async function updateHospital(id: string, body: HospitalLimitsUpdate): Promise<Hospital> {
  const result = await api.PATCH('/platform/hospitals/{id}', { params: { path: { id } }, body });
  return hospitalSchema.parse(requireData(result));
}
