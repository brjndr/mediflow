import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createLabTest,
  fetchLabRanges,
  fetchLabServices,
  fetchLabTest,
  fetchLabTests,
  resolveLabRange,
  saveLabRanges,
  setLabTestArchived,
  updateLabTest,
  type LabTestFilters,
} from '../api';
import type { AgeUnit } from '../age';
import type { LabRange, LabTestCreate, LabTestUpdate, PatientSex } from '../types';

/** Every key is prefixed with the tenant, so one hospital's catalog never shows in another. */
export const labTestKeys = createTenantKeys('lab-tests');
const rangesKey = (tenantId: string, labTestId: string) =>
  [...labTestKeys.detail(tenantId, labTestId), 'ranges'] as const;

export const LAB_TESTS_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 300;
/** How many choices a picker offers at a time: the rest are found by typing. */
export const PICKER_SIZE = 20;

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

/** The catalog, one server page at a time. Search and every filter are the server's job. */
export function useLabTests(filters: LabTestFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: labTestKeys.list(tenantId ?? '', { ...filters, q, limit: LAB_TESTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchLabTests({ ...filters, q, cursor: pageParam, limit: LAB_TESTS_PAGE_SIZE }, signal),
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
        (previousFilters as LabTestFilters | undefined)?.archived === filters.archived;
      return same ? previous : undefined;
    },
  });
}

export function useLabTest(labTestId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: labTestKeys.detail(tenantId ?? '', labTestId),
    queryFn: ({ signal }) => fetchLabTest(labTestId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** The single tests a panel can be made of, by a word of the code or name. */
export function useComponentChoices(search: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  const q = search.trim();
  return useQuery({
    queryKey: labTestKeys.list(tenantId ?? '', { choices: 'components', q }),
    queryFn: ({ signal }) =>
      fetchLabTests(
        { q, department: '', kind: 'test', archived: false, limit: PICKER_SIZE },
        signal,
      ),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The laboratory services a test can be charged as, by a word of the code or name. */
export function useServiceChoices(search: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  const q = search.trim();
  return useQuery({
    queryKey: labTestKeys.list(tenantId ?? '', { choices: 'services', q }),
    queryFn: ({ signal }) => fetchLabServices(q, PICKER_SIZE, signal),
    enabled: enabled && tenantId !== undefined,
    // Another module's list, which nothing here hears of when it changes: asked afresh each time
    // the form opens, so a service added a moment ago is offered.
    staleTime: 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useLabRanges(labTestId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: rangesKey(tenantId ?? '', labTestId),
    queryFn: ({ signal }) => fetchLabRanges(labTestId, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/**
 * After a change to a test, everything of the catalog is asked for again: the lists, the test,
 * and the panels that show its name.
 */
function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    return queryClient.invalidateQueries({ queryKey: labTestKeys.all(tenantId) });
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

export function useCreateLabTest() {
  const refresh = useRefresh();
  // A key identifies one test as filled in: sending the same again reuses it, an edited form
  // gets a new one.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (body: LabTestCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createLabTest(body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

/**
 * Changes a test from the version that was on screen, or archives and restores it. The answer
 * goes into the cache at once, so the next change is made from the saved version even if the
 * refresh that follows fails.
 */
export function useUpdateLabTest(labTestId: string) {
  const queryClient = useQueryClient();
  const sameSession = useSameSession();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (change: { body: LabTestUpdate } | { archived: boolean }) =>
      'body' in change
        ? updateLabTest(labTestId, change.body)
        : setLabTestArchived(labTestId, change.archived),
    onSuccess: (saved) => {
      const tenantId = sameSession();
      if (tenantId) queryClient.setQueryData(labTestKeys.detail(tenantId, labTestId), saved);
    },
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
  });
}

/** Replaces a test's reference ranges, from the version of them that was on screen. */
export function useSaveLabRanges(labTestId: string) {
  const queryClient = useQueryClient();
  const sameSession = useSameSession();
  return useMutation({
    mutationFn: (body: { ranges: LabRange[]; expectedVersion: number }) =>
      saveLabRanges(labTestId, body),
    onSuccess: (saved) => {
      const tenantId = sameSession();
      if (tenantId) queryClient.setQueryData(rangesKey(tenantId, labTestId), saved);
    },
    onSettled: () => {
      const tenantId = sameSession();
      if (!tenantId) return;
      return queryClient.invalidateQueries({ queryKey: rangesKey(tenantId, labTestId) });
    },
  });
}

/** Asks the server which saved range applies to a patient. Nothing of the answer is kept. */
export function useResolveLabRange(labTestId: string) {
  return useMutation({
    mutationFn: (query: { ageValue: number; ageUnit: AgeUnit; sex: PatientSex }) =>
      resolveLabRange(labTestId, query),
    gcTime: 0,
  });
}
