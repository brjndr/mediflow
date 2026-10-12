import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchCodes, setCodeFavourite, type CodeFilters } from '../api';
import type { CodeSystem } from '../types';

/**
 * The codes are the same everywhere, but which are favourites is the hospital's own: every key
 * is prefixed with the tenant, so one hospital's favourites never show in another.
 */
export const codeKeys = createTenantKeys('codes');

export const CODES_PAGE_SIZE = 25;
/** How many codes a search box offers. The rest are found by typing more. */
export const SUGGESTIONS = 10;
export const SEARCH_DEBOUNCE_MS = 300;

/** A code set changes with a yearly revision; favourites when a manager changes them. */
const STALE_TIME_MS = 5 * 60_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** A code set, one server page at a time. It is never loaded whole. */
export function useCodes(filters: CodeFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: codeKeys.list(tenantId ?? '', { ...filters, q, limit: CODES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCodes({ ...filters, q, cursor: pageParam, limit: CODES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    // The last page stays while a search is typed, but only of the same code set and view at
    // the same hospital.
    placeholderData: (previous, previousQuery) => {
      const [, previousTenant, , , previousFilters] = previousQuery?.queryKey ?? [];
      const before = previousFilters as CodeFilters | undefined;
      const same =
        previousTenant === tenantId &&
        before?.system === filters.system &&
        before.favourites === filters.favourites;
      return same ? previous : undefined;
    },
  });
}

/**
 * What a search box offers for what has been typed: the first few matches, the hospital's
 * favourites first. With nothing typed it is the favourites alone.
 */
export function useCodeSuggestions(system: CodeSystem, search: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  const q = search.trim();
  return useQuery({
    queryKey: codeKeys.list(tenantId ?? '', { as: 'suggestions', system, q }),
    queryFn: ({ signal }) =>
      fetchCodes({ system, q, favourites: q === '', limit: SUGGESTIONS }, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    select: (page) => page.items,
    placeholderData: (previous, previousQuery) => {
      const [, previousTenant, , , previousFilters] = previousQuery?.queryKey ?? [];
      const before = previousFilters as { system?: CodeSystem; q?: string } | undefined;
      // The last matches stay while more is typed: of the same code set at the same hospital,
      // and never the favourites standing in for a search, or a search for the favourites.
      const same = previousTenant === tenantId && before?.system === system;
      return same && q !== '' && before.q !== '' ? previous : undefined;
    },
  });
}

/** Marks a code as a favourite of the hospital, or takes the mark away. */
export function useCodeFavourite() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: ({ codeId, favourite }: { codeId: string; favourite: boolean }) =>
      setCodeFavourite(codeId, favourite),
    // Favourites come first in every list and search, so all of them are asked for again.
    onSettled: () => {
      if (!tenantId) return;
      return queryClient.invalidateQueries({ queryKey: codeKeys.all(tenantId) });
    },
  });
}
