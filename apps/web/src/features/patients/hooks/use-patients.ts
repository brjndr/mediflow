import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchPatients } from '../api';
import type { PatientSort } from '../types';

/** Every key is prefixed with the tenant, so one hospital's patients are never shown in another. */
export const patientKeys = createTenantKeys('patients');

export const PATIENT_PAGE_SIZES = [25, 50, 100] as const;
export const SEARCH_DEBOUNCE_MS = 300;

/** Patient data changes at the front desk all day: keep it fresh. */
const STALE_TIME_MS = 15_000;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface PatientFilters {
  q: string;
  sort: PatientSort | null;
  limit: number;
}

/**
 * The patient list, one server page at a time. Search and sort are the server's job: any change
 * is a new query that starts from the first page, and the previous request is aborted.
 */
export function usePatients({ q, sort, limit }: PatientFilters) {
  const tenantId = useTenant()?.id;
  const term = q.trim();
  return useInfiniteQuery({
    queryKey: patientKeys.list(tenantId ?? '', { q: term, sort, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchPatients({ q: term, cursor: pageParam, limit, sort: sort ?? undefined }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous) => previous,
  });
}
