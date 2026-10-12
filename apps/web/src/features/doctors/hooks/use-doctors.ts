import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createDoctor,
  fetchAvailability,
  fetchCandidates,
  fetchDoctor,
  fetchDoctors,
  saveAvailability,
  updateDoctor,
  type DoctorFilters,
} from '../api';
import type { DoctorCreate, DoctorSession, DoctorUpdate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's doctors never show in another. */
export const doctorKeys = createTenantKeys('doctors');

/** A doctor's working hours, under the doctor's own key so both go together. */
export const availabilityKey = (tenantId: string, doctorId: string) =>
  [...doctorKeys.detail(tenantId, doctorId), 'availability'] as const;

const candidatesKey = (tenantId: string, q: string) =>
  [...doctorKeys.all(tenantId), 'candidates', q] as const;

export const DOCTORS_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 300;
const CANDIDATES_SHOWN = 10;

/** Staff and their hours change rarely. */
const STALE_TIME_MS = 60_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The doctor list, one server page at a time. Search and filters are the server's job. */
export function useDoctors(filters: DoctorFilters) {
  const tenantId = useTenant()?.id;
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: doctorKeys.list(tenantId ?? '', { ...filters, q, limit: DOCTORS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchDoctors({ ...filters, q, cursor: pageParam, limit: DOCTORS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

export function useDoctor(doctorId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: doctorKeys.detail(tenantId ?? '', doctorId),
    queryFn: ({ signal }) => fetchDoctor(doctorId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** Staff members a profile can be created for. Asked for only while someone is choosing. */
export function useCandidates(q: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  const term = q.trim();
  return useQuery({
    queryKey: candidatesKey(tenantId ?? '', term),
    queryFn: ({ signal }) => fetchCandidates({ q: term, limit: CANDIDATES_SHOWN }, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

/** Everything about doctors at this hospital is asked for again: lists, profiles, candidates. */
function useRefreshDoctors() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) return queryClient.invalidateQueries({ queryKey: doctorKeys.all(tenantId) });
  };
}

export function useCreateDoctor() {
  const refresh = useRefreshDoctors();
  // A key identifies one profile as filled in: sending the same again reuses it, an edited form
  // gets a new one.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (body: DoctorCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createDoctor(body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

/**
 * Changes a profile from the version that was on screen. The answer goes into the cache at once,
 * so the next change is made from the saved version even if the refresh that follows fails.
 */
export function useUpdateDoctor(doctorId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: (body: DoctorUpdate) => updateDoctor(doctorId, body),
    onSuccess: (saved) => {
      if (tenantId) queryClient.setQueryData(doctorKeys.detail(tenantId, doctorId), saved);
    },
    // Also after a failure: a conflict means what is on screen is out of date. The profile and
    // the lists, not the working hours, which have their own version and their own editor.
    onSettled: () => {
      if (!tenantId) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: doctorKeys.lists(tenantId) }),
        queryClient.invalidateQueries({
          queryKey: doctorKeys.detail(tenantId, doctorId),
          exact: true,
        }),
      ]);
    },
  });
}

export function useAvailability(doctorId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: availabilityKey(tenantId ?? '', doctorId),
    queryFn: ({ signal }) => fetchAvailability(doctorId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useSaveAvailability(doctorId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: (body: { sessions: DoctorSession[]; expectedVersion: number }) =>
      saveAvailability(doctorId, body),
    onSuccess: (saved) => {
      if (tenantId) queryClient.setQueryData(availabilityKey(tenantId, doctorId), saved);
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: availabilityKey(tenantId, doctorId) });
      }
    },
  });
}
