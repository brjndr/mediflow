import { api, requireData } from '@/shared/api';
import {
  servicePageSchema,
  servicePricePageSchema,
  servicePriceSchema,
  serviceSchema,
} from './schemas';
import type {
  Service,
  ServiceCategory,
  ServiceCreate,
  ServicePage,
  ServicePrice,
  ServicePriceCreate,
  ServicePricePage,
  ServiceUpdate,
} from './types';

export interface ServiceFilters {
  /** A code or a name of a service. Not patient data, so it may be a query. */
  q: string;
  category: ServiceCategory | '';
  archived: boolean;
}

export async function fetchServices(
  { cursor, limit, q, category, archived }: ServiceFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ServicePage> {
  const result = await api.GET('/services', {
    params: {
      query: { cursor, limit, q: q || undefined, category: category || undefined, archived },
    },
    signal,
  });
  return servicePageSchema.parse(requireData(result));
}

export async function fetchService(serviceId: string, signal?: AbortSignal): Promise<Service> {
  const result = await api.GET('/services/{serviceId}', {
    params: { path: { serviceId } },
    signal,
  });
  return serviceSchema.parse(requireData(result));
}

/**
 * Adds a service. The key makes a repeat of the same request (a double click, a retry after a
 * lost answer) add one service, not fail on its own code.
 */
export async function createService(body: ServiceCreate, idempotencyKey: string): Promise<Service> {
  const result = await api.POST('/services', {
    body,
    params: { header: { 'Idempotency-Key': idempotencyKey } },
  });
  return serviceSchema.parse(requireData(result));
}

export async function updateService(serviceId: string, body: ServiceUpdate): Promise<Service> {
  const result = await api.PATCH('/services/{serviceId}', {
    params: { path: { serviceId } },
    body,
  });
  return serviceSchema.parse(requireData(result));
}

export async function setServiceArchived(serviceId: string, archived: boolean): Promise<Service> {
  const params = { path: { serviceId } };
  const result = archived
    ? await api.POST('/services/{serviceId}/archive', { params })
    : await api.POST('/services/{serviceId}/restore', { params });
  return serviceSchema.parse(requireData(result));
}

/** How many prices of a service are asked for: its history is a handful of rows. */
export const PRICE_HISTORY_LIMIT = 50;

export async function fetchServicePrices(
  serviceId: string,
  signal?: AbortSignal,
): Promise<ServicePricePage> {
  const result = await api.GET('/services/{serviceId}/prices', {
    params: { path: { serviceId }, query: { limit: PRICE_HISTORY_LIMIT } },
    signal,
  });
  return servicePricePageSchema.parse(requireData(result));
}

export async function setServicePrice(
  serviceId: string,
  body: ServicePriceCreate,
  idempotencyKey: string,
): Promise<ServicePrice> {
  const result = await api.POST('/services/{serviceId}/prices', {
    params: { path: { serviceId }, header: { 'Idempotency-Key': idempotencyKey } },
    body,
  });
  return servicePriceSchema.parse(requireData(result));
}

/** Withdraws a price that has not come into force yet. */
export async function cancelServicePrice(serviceId: string, priceId: string): Promise<void> {
  await api.DELETE('/services/{serviceId}/prices/{priceId}', {
    params: { path: { serviceId, priceId } },
  });
}
