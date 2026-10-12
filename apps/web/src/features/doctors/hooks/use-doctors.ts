import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
  return useMutation({
    mutationFn: (body: DoctorCreate) => createDoctor(body),
    onSettled: refresh,
  });
}

/** Changes a profile from the version that was on screen. */
export function useUpdateDoctor(doctorId: string) {
  const refresh = useRefreshDoctors();
  return useMutation({
    mutationFn: (body: DoctorUpdate) => updateDoctor(doctorId, body),
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
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
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: availabilityKey(tenantId, doctorId) });
      }
    },
  });
}
