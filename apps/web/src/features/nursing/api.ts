import { api, requireData } from '@/shared/api';
import {
  stayDetailSchema,
  stayPageSchema,
  wardOptionsSchema,
  wardVitalPageSchema,
  wardVitalSchema,
} from './schemas';
import type {
  StayPage,
  StayRow,
  WardOption,
  WardVital,
  WardVitalCreate,
  WardVitalPage,
} from './types';

/** The patients now on the wards, newest admission first, of one ward or of every ward. */
export async function fetchStays(
  { wardId, cursor, limit }: { wardId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<StayPage> {
  const result = await api.GET('/admissions', {
    params: { query: { status: 'admitted', wardId: wardId || undefined, cursor, limit } },
    signal,
  });
  return stayPageSchema.parse(requireData(result));
}

export async function fetchStay(admissionId: string, signal?: AbortSignal): Promise<StayRow> {
  const result = await api.GET('/admissions/{admissionId}', {
    params: { path: { admissionId } },
    signal,
  });
  return stayDetailSchema.parse(requireData(result)).admission;
}

/** The wards to filter by: names and ids only. A hospital has a few dozen at most. */
export async function fetchWardOptions(signal?: AbortSignal): Promise<WardOption[]> {
  const result = await api.GET('/wards', { params: { query: { limit: 100 } }, signal });
  return wardOptionsSchema.parse(requireData(result)).items;
}

/** The readings of a stay by the time they were taken, newest first. */
export async function fetchVitals(
  { admissionId, cursor, limit }: { admissionId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<WardVitalPage> {
  const result = await api.GET('/admissions/{admissionId}/vitals', {
    params: { path: { admissionId }, query: { cursor, limit } },
    signal,
  });
  return wardVitalPageSchema.parse(requireData(result));
}

export async function recordVitals(
  admissionId: string,
  body: WardVitalCreate,
  key: string,
): Promise<WardVital> {
  const result = await api.POST('/admissions/{admissionId}/vitals', {
    params: { path: { admissionId }, header: { 'idempotency-key': key } },
    body,
  });
  return wardVitalSchema.parse(requireData(result));
}

export async function correctVitals(
  admissionId: string,
  vitalId: string,
  body: WardVitalCreate & { reason: string },
  key: string,
): Promise<WardVital> {
  const result = await api.POST('/admissions/{admissionId}/vitals/{vitalId}/correct', {
    params: { path: { admissionId, vitalId }, header: { 'idempotency-key': key } },
    body,
  });
  return wardVitalSchema.parse(requireData(result));
}
