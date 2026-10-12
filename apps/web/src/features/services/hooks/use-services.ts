import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  cancelServicePrice,
  createService,
  fetchService,
  fetchServicePrices,
  fetchServices,
  setServiceArchived,
  setServicePrice,
  updateService,
  type ServiceFilters,
} from '../api';
import type { ServiceCreate, ServicePriceCreate, ServiceUpdate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's catalog never shows in another. */
export const serviceKeys = createTenantKeys('services');

/** A service's prices, under the service's own key so both go together. */
export const pricesKey = (tenantId: string, serviceId: string) =>
  [...serviceKeys.detail(tenantId, serviceId), 'prices'] as const;

export const SERVICES_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 300;

/** A catalog changes rarely, but a price shown must be the price charged: keep it fresh. */
const STALE_TIME_MS = 60_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The catalog, one server page at a time. Search and filters are the server's job. */
export function useServices(filters: ServiceFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: serviceKeys.list(tenantId ?? '', { ...filters, q, limit: SERVICES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchServices({ ...filters, q, cursor: pageParam, limit: SERVICES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    // The last page stays while a search is typed, but only of the same view at the same
    // hospital: the archived view and the active one are different lists.
    placeholderData: (previous, previousQuery) => {
      const [, previousTenant, , , previousFilters] = previousQuery?.queryKey ?? [];
      const same =
        previousTenant === tenantId &&
        (previousFilters as ServiceFilters | undefined)?.archived === filters.archived;
      return same ? previous : undefined;
    },
  });
}

export function useService(serviceId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: serviceKeys.detail(tenantId ?? '', serviceId),
    queryFn: ({ signal }) => fetchService(serviceId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useServicePrices(serviceId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: pricesKey(tenantId ?? '', serviceId),
    queryFn: ({ signal }) => fetchServicePrices(serviceId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** After a change to one service: the lists, the service and its prices are asked for again. */
function useRefresh(serviceId?: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: serviceKeys.lists(tenantId) }),
      serviceId
        ? queryClient.invalidateQueries({ queryKey: serviceKeys.detail(tenantId, serviceId) })
        : undefined,
    ]);
  };
}

export function useCreateService() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: ServiceCreate) => createService(body),
    onSettled: refresh,
  });
}

/**
 * Changes a service from the version that was on screen, or archives and restores it. The
 * answer goes into the cache at once, so the next change is made from the saved version even if
 * the refresh that follows fails.
 */
export function useUpdateService(serviceId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const refresh = useRefresh(serviceId);
  return useMutation({
    mutationFn: (change: { body: ServiceUpdate } | { archived: boolean }) =>
      'body' in change
        ? updateService(serviceId, change.body)
        : setServiceArchived(serviceId, change.archived),
    onSuccess: (saved) => {
      if (tenantId) queryClient.setQueryData(serviceKeys.detail(tenantId, serviceId), saved);
    },
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
  });
}

/** Sets a new price from a date, or withdraws one that has not come into force. */
export function usePriceChange(serviceId: string) {
  const refresh = useRefresh(serviceId);
  return useMutation({
    mutationFn: async (change: { set: ServicePriceCreate } | { cancel: string }) => {
      if ('set' in change) await setServicePrice(serviceId, change.set);
      else await cancelServicePrice(serviceId, change.cancel);
    },
    onSettled: refresh,
  });
}
