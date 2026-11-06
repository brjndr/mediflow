import { api, requireData } from '@/shared/api';
import { setDetailSchema, setPageSchema } from './sets-schemas';
import type {
  PrescriptionSetCreate,
  PrescriptionSetDetail,
  PrescriptionSetPage,
  PrescriptionSetUpdate,
} from './types';

// Prescription sets (#394). Every address holds ids only; a set holds no patient.

/** The sets the caller may use, by name. A hospital keeps a handful, so one page of 100. */
export async function fetchPrescriptionSets(
  signal?: AbortSignal,
  archived = false,
): Promise<PrescriptionSetPage> {
  const result = await api.GET('/prescription-sets', {
    params: { query: { limit: 100, ...(archived ? { archived: true } : {}) } },
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

/** Renames, changes the lines of, archives or restores a set, from the version the edit began at. */
export async function updatePrescriptionSet(
  setId: string,
  body: PrescriptionSetUpdate,
): Promise<PrescriptionSetDetail> {
  const result = await api.PATCH('/prescription-sets/{setId}', {
    params: { path: { setId } },
    body,
  });
  return setDetailSchema.parse(requireData(result));
}
