import { api, requireData } from '@/shared/api';
import { setDetailSchema, setPageSchema } from './sets-schemas';
import type { PrescriptionSetCreate, PrescriptionSetDetail, PrescriptionSetPage } from './types';

// Prescription sets (#394). Every address holds ids only; a set holds no patient.

/** The sets the caller may use, by name. A hospital keeps a handful, so one page of 100. */
export async function fetchPrescriptionSets(signal?: AbortSignal): Promise<PrescriptionSetPage> {
  const result = await api.GET('/prescription-sets', {
    params: { query: { limit: 100 } },
    signal,
  });
  return setPageSchema.parse(requireData(result));
}

export async function fetchPrescriptionSet(
  setId: string,
  signal?: AbortSignal,
): Promise<PrescriptionSetDetail> {
  const result = await api.GET('/prescription-sets/{setId}', {
    params: { path: { setId } },
    signal,
  });
  return setDetailSchema.parse(requireData(result));
}

export async function createPrescriptionSet(
  body: PrescriptionSetCreate,
  idempotencyKey: string,
): Promise<PrescriptionSetDetail> {
  const result = await api.POST('/prescription-sets', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return setDetailSchema.parse(requireData(result));
}
