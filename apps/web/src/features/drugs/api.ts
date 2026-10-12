import { api, requireData } from '@/shared/api';
import { drugMatchesSchema, drugPageSchema, drugSchema } from './schemas';
import type {
  Drug,
  DrugCreate,
  DrugForm,
  DrugPage,
  DrugSchedule,
  DrugType,
  DrugUpdate,
} from './types';

export interface DrugFilters {
  /** A generic name or a brand. Not patient data, so it may be a query. */
  q: string;
  type: DrugType | '';
  form: DrugForm | '';
  schedule: DrugSchedule | '';
  controlled: boolean;
  archived: boolean;
}

export async function fetchDrugs(
  {
    cursor,
    limit,
    q,
    type,
    form,
    schedule,
    controlled,
    archived,
  }: DrugFilters & {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<DrugPage> {
  const result = await api.GET('/drugs', {
    params: {
      query: {
        cursor,
        limit,
        q: q || undefined,
        type: type || undefined,
        form: form || undefined,
        schedule: schedule || undefined,
        controlled: controlled || undefined,
        archived,
      },
    },
    signal,
  });
  return drugPageSchema.parse(requireData(result));
}

export async function fetchDrug(drugId: string, signal?: AbortSignal): Promise<Drug> {
  const result = await api.GET('/drugs/{drugId}', { params: { path: { drugId } }, signal });
  return drugSchema.parse(requireData(result));
}

/** Items that may be the one about to be added: the same generic name in the same form. */
export async function checkDrugDuplicates(
  query: { genericName: string; form: DrugForm },
  signal?: AbortSignal,
): Promise<Drug[]> {
  const result = await api.POST('/drugs/duplicate-check', { body: query, signal });
  return drugMatchesSchema.parse(requireData(result)).items;
}

/**
 * Adds an item. The key makes a repeat of the same request (a double click, a retry after a lost
 * answer) add one item, not fail on being its own duplicate.
 */
export async function createDrug(body: DrugCreate, idempotencyKey: string): Promise<Drug> {
  const result = await api.POST('/drugs', {
    body,
    params: { header: { 'Idempotency-Key': idempotencyKey } },
  });
  return drugSchema.parse(requireData(result));
}

export async function updateDrug(drugId: string, body: DrugUpdate): Promise<Drug> {
  const result = await api.PATCH('/drugs/{drugId}', { params: { path: { drugId } }, body });
  return drugSchema.parse(requireData(result));
}

export async function setDrugArchived(drugId: string, archived: boolean): Promise<Drug> {
  const params = { path: { drugId } };
  const result = archived
    ? await api.POST('/drugs/{drugId}/archive', { params })
    : await api.POST('/drugs/{drugId}/restore', { params });
  return drugSchema.parse(requireData(result));
}
