import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  checkDrugDuplicates,
  createDrug,
  fetchDrug,
  fetchDrugs,
  setDrugArchived,
  updateDrug,
  type DrugFilters,
} from '../api';
import type { DrugCreate, DrugForm, DrugUpdate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's catalog never shows in another. */
export const drugKeys = createTenantKeys('drugs');

export const DRUGS_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 300;

/** A catalog changes rarely. */
const STALE_TIME_MS = 60_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The catalog, one server page at a time. It can hold tens of thousands of items, so search and
 * every filter are the server's job and nothing is ever filtered in the browser.
 */
export function useDrugs(filters: DrugFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: drugKeys.list(tenantId ?? '', { ...filters, q, limit: DRUGS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchDrugs({ ...filters, q, cursor: pageParam, limit: DRUGS_PAGE_SIZE }, signal),
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
        (previousFilters as DrugFilters | undefined)?.archived === filters.archived;
      return same ? previous : undefined;
    },
  });
}

/** How many medicines a search box offers. The rest are found by typing more. */
export const SUGGESTIONS = 10;

/**
 * What a prescribing search box offers for what has been typed: the first medicines that match,
 * archived ones and consumables left out, unless consumables are asked for too (stock, #102).
 * Nothing is asked before something is typed.
 */
export function useMedicineSuggestions(
  search: string,
  enabled: boolean,
  includeConsumables = false,
) {
  const tenantId = useTenant()?.id;
  const q = search.trim();
  const filters: DrugFilters = {
    q,
    type: includeConsumables ? '' : 'medicine',
    form: '',
    schedule: '',
    controlled: false,
    archived: false,
  };
  return useQuery({
    queryKey: drugKeys.list(tenantId ?? '', { as: 'suggestions', q, includeConsumables }),
    queryFn: ({ signal }) => fetchDrugs({ ...filters, limit: SUGGESTIONS }, signal),
    enabled: enabled && tenantId !== undefined && q !== '',
    staleTime: STALE_TIME_MS,
    select: (page) => page.items,
    // The last matches stay while more is typed, at the same hospital only.
    placeholderData: (previous, previousQuery) => {
      const [, previousTenant] = previousQuery?.queryKey ?? [];
      return previousTenant === tenantId ? previous : undefined;
    },
  });
}

export function useDrug(drugId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: drugKeys.detail(tenantId ?? '', drugId),
    queryFn: ({ signal }) => fetchDrug(drugId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** Asked when an item is about to be added. Nothing of it is kept once the form is gone. */
export function useCheckDrugDuplicates() {
  return useMutation({
    mutationFn: (query: { genericName: string; form: DrugForm }) => checkDrugDuplicates(query),
    gcTime: 0,
  });
}

function useRefresh(drugId?: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: drugKeys.lists(tenantId) }),
      drugId
        ? queryClient.invalidateQueries({ queryKey: drugKeys.detail(tenantId, drugId) })
        : undefined,
    ]);
  };
}

export function useCreateDrug() {
  const refresh = useRefresh();
  // A key identifies one item as filled in: sending the same again reuses it, an edited form
  // gets a new one.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (body: DrugCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createDrug(body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

/**
 * Changes an item from the version that was on screen, or archives and restores it. The answer
 * goes into the cache at once, so the next change is made from the saved version even if the
 * refresh that follows fails.
 */
export function useUpdateDrug(drugId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const refresh = useRefresh(drugId);
  return useMutation({
    mutationFn: (change: { body: DrugUpdate } | { archived: boolean }) =>
      'body' in change ? updateDrug(drugId, change.body) : setDrugArchived(drugId, change.archived),
    onSuccess: (saved) => {
      // Nothing is written if the answer arrives after the session ended or moved to another
      // hospital: the cache it would go into is no longer this person's at this hospital.
      const session = queryClient.getQueryData<Session | null>(sessionKey);
      if (!tenantId || session?.activeTenant?.id !== tenantId) return;
      queryClient.setQueryData(drugKeys.detail(tenantId, drugId), saved);
    },
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
  });
}
