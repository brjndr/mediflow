import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createTenantKeys, isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchPatients } from '../api';
import type { PatientSort } from '../types';

/** Every key is prefixed with the tenant, so one hospital's patients are never shown in another. */
export const patientKeys = createTenantKeys('patients');

/**
 * Possible duplicates for details still being typed (see `useDuplicateSuggestions`). The details
 * are part of the key, so it is kept in memory only for as long as the form is open.
 */
export const patientDuplicatesKey = (tenantId: string, query: unknown) =>
  [...patientKeys.all(tenantId), 'duplicates', query] as const;

/**
 * Where an unsaved edit of a patient is held (see `use-update-patient`). Under the record's own
 * key, so it belongs to the hospital like the record and goes when the record's keys go.
 */
export const patientDraftKey = (tenantId: string, id: string) =>
  [...patientKeys.detail(tenantId, id), 'draft'] as const;

export const PATIENT_PAGE_SIZES = [25, 50, 100] as const;
export const SEARCH_DEBOUNCE_MS = 300;

/** Failures worth a second try: the request may not have reached a working server at all. */
const RETRYABLE = new Set(['network', 'timeout', 'server']);

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
    // The search is a POST so that the term stays out of the address, which means the fetch
    // wrapper does not retry it as it would a GET. It only reads, so a passing failure (no
    // network, a timeout, a server that is restarting) is tried again here.
    retry: (failures, error) => failures < 2 && isApiError(error) && RETRYABLE.has(error.code),
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
  });
}
