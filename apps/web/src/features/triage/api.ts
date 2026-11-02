import { api, requireData } from '@/shared/api';
import { allergyListSchema, vitalRangesSchema, vitalsPageSchema, vitalsSchema } from './schemas';
import type {
  AllergyList,
  AllergyListUpdate,
  PrintableTriage,
  Vitals,
  VitalsCreate,
  VitalsPage,
  VitalRanges,
} from './types';

// Every address holds ids only: nothing about the patient is in a URL.

/** The patient's readings, newest first; only those of one queue token when one is given. */
export async function fetchVitals(
  {
    patientId,
    queueTokenId,
    cursor,
    limit,
  }: { patientId: string; queueTokenId?: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<VitalsPage> {
  const result = await api.GET('/patients/{patientId}/vitals', {
    params: { path: { patientId }, query: { queueTokenId, cursor, limit } },
    signal,
  });
  return vitalsPageSchema.parse(requireData(result));
}

export async function fetchReading(
  patientId: string,
  vitalsId: string,
  signal?: AbortSignal,
): Promise<Vitals> {
  const result = await api.GET('/patients/{patientId}/vitals/{vitalsId}', {
    params: { path: { patientId, vitalsId } },
    signal,
  });
  return vitalsSchema.parse(requireData(result));
}

/** Records a reading. The idempotency key makes a retry or a double click record it once. */
export async function recordVitals(
  patientId: string,
  body: VitalsCreate,
  idempotencyKey: string,
): Promise<Vitals> {
  const result = await api.POST('/patients/{patientId}/vitals', {
    params: { path: { patientId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return vitalsSchema.parse(requireData(result));
}

/** The hospital's ranges for this patient, or null when none apply (a child). */
export async function fetchVitalRanges(
  patientId: string,
  signal?: AbortSignal,
): Promise<VitalRanges> {
  const result = await api.GET('/patients/{patientId}/vital-ranges', {
    params: { path: { patientId } },
    signal,
  });
  return vitalRangesSchema.parse(requireData(result));
}

export async function fetchAllergies(
  patientId: string,
  signal?: AbortSignal,
): Promise<AllergyList> {
  const result = await api.GET('/patients/{patientId}/allergies', {
    params: { path: { patientId } },
    signal,
  });
  return allergyListSchema.parse(requireData(result));
}

/** Replaces the list from the version the edit started from: someone else's change first is 409. */
export async function saveAllergies(
  patientId: string,
  body: AllergyListUpdate,
): Promise<AllergyList> {
  const result = await api.PUT('/patients/{patientId}/allergies', {
    params: { path: { patientId } },
    body,
  });
  return allergyListSchema.parse(requireData(result));
}

/**
 * The parts of triage a printed document carries, read afresh and only those asked for (#398):
 * the allergies, and the newest reading with its chief complaint.
 */
export async function readTriageForPrint(
  patientId: string,
  parts: { allergies: boolean; vitals: boolean },
  signal?: AbortSignal,
): Promise<PrintableTriage> {
  const [allergies, vitals] = await Promise.all([
    parts.allergies ? fetchAllergies(patientId, signal) : undefined,
    parts.vitals ? fetchVitals({ patientId, limit: 1 }, signal) : undefined,
  ]);
  return {
    ...(allergies ? { allergies } : {}),
    ...(vitals ? { vitals: vitals.items[0] ?? null } : {}),
  };
}
