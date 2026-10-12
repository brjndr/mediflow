import { api, requireData } from '@/shared/api';
import { availabilitySchema, candidatePageSchema, doctorPageSchema, doctorSchema } from './schemas';
import type {
  Doctor,
  DoctorAvailability,
  DoctorCandidatePage,
  DoctorCreate,
  DoctorPage,
  DoctorSession,
  DoctorUpdate,
} from './types';

export interface DoctorFilters {
  /** A name or a specialization. A staff member's name, not patient data, so it may be a query. */
  q: string;
  departmentId: string;
  active: boolean;
}

export async function fetchDoctors(
  { cursor, limit, q, departmentId, active }: DoctorFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<DoctorPage> {
  const result = await api.GET('/doctors', {
    params: {
      query: { cursor, limit, q: q || undefined, departmentId: departmentId || undefined, active },
    },
    signal,
  });
  return doctorPageSchema.parse(requireData(result));
}

export async function fetchDoctor(doctorId: string, signal?: AbortSignal): Promise<Doctor> {
  const result = await api.GET('/doctors/{doctorId}', {
    params: { path: { doctorId } },
    signal,
  });
  return doctorSchema.parse(requireData(result));
}

/**
 * Creates a profile. The key makes a repeat of the same request (a double click, a retry after a
 * lost answer) create one profile, not fail on its own.
 */
export async function createDoctor(body: DoctorCreate, idempotencyKey: string): Promise<Doctor> {
  const result = await api.POST('/doctors', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return doctorSchema.parse(requireData(result));
}

export async function updateDoctor(doctorId: string, body: DoctorUpdate): Promise<Doctor> {
  const result = await api.PATCH('/doctors/{doctorId}', {
    params: { path: { doctorId } },
    body,
  });
  return doctorSchema.parse(requireData(result));
}

export async function fetchCandidates(
  { q, limit }: { q: string; limit: number },
  signal?: AbortSignal,
): Promise<DoctorCandidatePage> {
  const result = await api.GET('/doctors/candidates', {
    params: { query: { q: q || undefined, limit } },
    signal,
  });
  return candidatePageSchema.parse(requireData(result));
}

export async function fetchAvailability(
  doctorId: string,
  signal?: AbortSignal,
): Promise<DoctorAvailability> {
  const result = await api.GET('/doctors/{doctorId}/availability', {
    params: { path: { doctorId } },
    signal,
  });
  return availabilitySchema.parse(requireData(result));
}

export async function saveAvailability(
  doctorId: string,
  body: { sessions: DoctorSession[]; expectedVersion: number },
): Promise<DoctorAvailability> {
  const result = await api.PUT('/doctors/{doctorId}/availability', {
    params: { path: { doctorId } },
    body,
  });
  return availabilitySchema.parse(requireData(result));
}
