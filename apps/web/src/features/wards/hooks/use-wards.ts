import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createBedCategory,
  createWard,
  fetchBedCategories,
  fetchWard,
  fetchWards,
  runWardAction,
  setBedCategoryArchived,
  setWardArchived,
  updateBedCategory,
  updateWard,
  type WardAction,
  type WardFilters,
} from '../api';
import type { BedCategoryCreate, BedCategoryUpdate, WardCreate, WardUpdate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's wards never show in another. */
export const wardKeys = createTenantKeys('wards');

export const WARDS_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 300;
/** As many as one request may ask for. A hospital has a handful of bed categories. */
const CATEGORIES_LIMIT = 100;

/** Setup changes rarely. A bed's status changes with admissions, so a ward is asked for anew. */
const STALE_TIME_MS = 60_000;
const WARD_STALE_TIME_MS = 10_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The wards, one server page at a time. Search is the server's job. */
export function useWards(filters: WardFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: wardKeys.list(tenantId ?? '', { ...filters, q, limit: WARDS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchWards({ ...filters, q, cursor: pageParam, limit: WARDS_PAGE_SIZE }, signal),
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
        (previousFilters as WardFilters | undefined)?.archived === filters.archived;
      return same ? previous : undefined;
    },
  });
}

export function useWard(wardId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: wardKeys.detail(tenantId ?? '', wardId),
    queryFn: ({ signal }) => fetchWard(wardId, signal),
    enabled: tenantId !== undefined,
    staleTime: WARD_STALE_TIME_MS,
  });
}

/** The hospital's bed categories, in use or archived. Few enough to be one page. */
export function useBedCategories(archived: boolean, enabled = true) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: wardKeys.list(tenantId ?? '', { as: 'bedCategories', archived }),
    queryFn: ({ signal }) => fetchBedCategories(archived, CATEGORIES_LIMIT, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    select: (page) => page.items,
  });
}

/** After a change, everything of the wards is asked for again: lists, counts, the ward. */
function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    return queryClient.invalidateQueries({ queryKey: wardKeys.all(tenantId) });
  };
}

/** Whether this is still the hospital the request was made at: else nothing goes in its cache. */
function useSameSession() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined && session?.activeTenant?.id === tenantId ? tenantId : null;
  };
}

/**
 * A key for each thing being added, as filled in: sending the same again reuses it, so a repeat
 * after a lost answer adds one and does not fail on its own name.
 */
function useAttemptKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    for(body: unknown) {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done() {
      attempt.current = undefined;
    },
  };
}

export function useCreateWard() {
  const refresh = useRefresh();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: (body: WardCreate) => createWard(body, attempt.for(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/** Changes a ward from the version that was on screen, or archives and restores it. */
export function useUpdateWard(wardId: string) {
  const queryClient = useQueryClient();
  const sameSession = useSameSession();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (change: { body: WardUpdate } | { archived: boolean }) =>
      'body' in change ? updateWard(wardId, change.body) : setWardArchived(wardId, change.archived),
    onSuccess: (saved) => {
      const tenantId = sameSession();
      if (tenantId) queryClient.setQueryData(wardKeys.detail(tenantId, wardId), saved);
    },
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
  });
}

/** What the screen asks for: the same as the API's actions, without the key it adds itself. */
export type WardChange =
  | { type: 'addRoom'; name: string }
  | { type: 'addBed'; roomId: string; number: string; bedCategoryId: string }
  | Exclude<WardAction, { type: 'addRoom' | 'addBed' }>;

/** One change to a room or a bed of a ward. The answer is the ward as it then is. */
export function useWardChange(wardId: string) {
  const queryClient = useQueryClient();
  const sameSession = useSameSession();
  const refresh = useRefresh();
  const attempt = useAttemptKey();
  const mutation = useMutation({
    mutationFn: (change: WardChange) =>
      runWardAction(
        wardId,
        change.type === 'addRoom' || change.type === 'addBed'
          ? { ...change, key: attempt.for(change) }
          : change,
      ),
    onSuccess: (saved) => {
      attempt.done();
      const tenantId = sameSession();
      if (tenantId) queryClient.setQueryData(wardKeys.detail(tenantId, wardId), saved);
    },
    onSettled: refresh,
  });
  // Called when a form is opened or left: what is added next is a new thing, not a repeat.
  return { ...mutation, newAttempt: attempt.done };
}

/** Adds, changes, archives or restores a bed category. */
export function useBedCategoryChange() {
  const refresh = useRefresh();
  const attempt = useAttemptKey();
  const mutation = useMutation({
    mutationFn: (
      change:
        | { create: BedCategoryCreate }
        | { id: string; body: BedCategoryUpdate }
        | { id: string; archived: boolean },
    ) => {
      if ('create' in change) return createBedCategory(change.create, attempt.for(change.create));
      return 'body' in change
        ? updateBedCategory(change.id, change.body)
        : setBedCategoryArchived(change.id, change.archived);
    },
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
  // Called when a form is opened or left: what is added next is a new thing, not a repeat.
  return { ...mutation, newAttempt: attempt.done };
}
