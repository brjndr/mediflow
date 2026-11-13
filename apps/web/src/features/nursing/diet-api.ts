import { api, requireData } from '@/shared/api';
import { kitchenListPageSchema, wardDietSchema } from './diet-schemas';
import type { KitchenListPage, WardDiet } from './types';

/** The patients admitted now with the diet each is on, of one ward or all, a page at a time. */
export async function fetchKitchenList(
  { wardId, cursor, limit }: { wardId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<KitchenListPage> {
  const result = await api.GET('/diet/kitchen-list', {
    params: { query: { wardId: wardId || undefined, cursor, limit } },
    signal,
  });
  return kitchenListPageSchema.parse(requireData(result));
}

/** The diet orders of a stay that are not cancelled, newest first. */
export async function fetchStayDiet(admissionId: string, signal?: AbortSignal): Promise<WardDiet> {
  const result = await api.GET('/admissions/{admissionId}/diet', {
    params: { path: { admissionId } },
    signal,
  });
  return wardDietSchema.parse(requireData(result));
}

/** A doctor's diet order for the stay's encounter: a diet order is its instructions. */
export async function placeDietOrder(
  encounterId: string,
  body: { instructions: string; priority: 'routine' | 'urgent' },
  idempotencyKey: string,
): Promise<void> {
  const result = await api.POST('/encounters/{encounterId}/orders', {
    params: { path: { encounterId }, header: { 'idempotency-key': idempotencyKey } },
    body: { type: 'diet', ...body },
  });
  requireData(result);
}
