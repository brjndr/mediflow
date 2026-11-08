import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  admitPatient,
  changeAdmissionBed,
  fetchAdmissions,
  fetchBedHistory,
  fetchBoard,
} from '../api';
import type { Admission, AdmissionCreate } from '../types';
import { bedKeys } from './use-board';

/** Every key is prefixed with the tenant, so one hospital's admissions never show in another. */
export const admissionKeys = createTenantKeys('admissions');

export const ADMISSIONS_PAGE_SIZE = 50;

/** The admissions newest first, one server page at a time. */
export function useAdmissions(status: 'admitted' | 'discharged' | '') {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: admissionKeys.list(tenantId ?? '', { status, limit: ADMISSIONS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchAdmissions({ status, cursor: pageParam, limit: ADMISSIONS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** As many beds as one request may ask for; a ward with more is narrowed by its category. */
const BEDS_LIMIT = 100;

/** The beds free to take a patient, of one ward or of every ward. Read fresh each time. */
export function useAvailableBeds(wardId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bedKeys.list(tenantId ?? '', { wardId, status: 'available', limit: BEDS_LIMIT }),
    queryFn: ({ signal }) => fetchBoard({ wardId, status: 'available', limit: BEDS_LIMIT }, signal),
    enabled: tenantId !== undefined,
    staleTime: 0,
    select: (page) => page.items,
  });
}

/** One key per request body: an identical resubmit (double click, retry) is done once. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
}

function useRefreshAfter() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return async () => {
    if (!tenantId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: admissionKeys.all(tenantId) }),
      queryClient.invalidateQueries({ queryKey: bedKeys.all(tenantId) }),
    ]);
  };
}

/** Admits a patient into a bed. Shown only once the server answers: a bed can be taken meanwhile. */
export function useAdmit() {
  const keyFor = useAttempt();
  const refresh = useRefreshAfter();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: AdmissionCreate) => admitPatient(body, keyFor(body)),
    onSettled: refresh,
  });
}

/** Gives an admitted patient a bed or moves them. */
export function useChangeBed() {
  const keyFor = useAttempt();
  const refresh = useRefreshAfter();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ admission, bedId }: { admission: Admission; bedId: string }) =>
      changeAdmissionBed(admission, bedId, keyFor([admission.id, admission.version, bedId])),
    onSettled: refresh,
  });
}

/** The beds one admission has been in. Read fresh: it grows with every move. */
export function useBedHistory(admissionId: string | undefined) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: admissionKeys.detail(tenantId ?? '', admissionId ?? ''),
    queryFn: ({ signal }) => fetchBedHistory(admissionId ?? '', signal),
    enabled: tenantId !== undefined && admissionId !== undefined,
    staleTime: 0,
  });
}
