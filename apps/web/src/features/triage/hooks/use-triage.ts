import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchAllergies,
  fetchReading,
  fetchVitalRanges,
  fetchVitals,
  recordVitals,
  saveAllergies,
} from '../api';
import type { AllergyListUpdate, VitalsCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's readings never show in another. */
export const triageKeys = createTenantKeys('triage');

const reading = (tenantId: string, patientId: string, vitalsId: string) =>
  [...triageKeys.all(tenantId), 'reading', patientId, vitalsId] as const;
const ranges = (tenantId: string, patientId: string) =>
  [...triageKeys.all(tenantId), 'ranges', patientId] as const;
const allergies = (tenantId: string, patientId: string) =>
  [...triageKeys.all(tenantId), 'allergies', patientId] as const;

export const VITALS_PAGE_SIZE = 25;

/** The patient's readings, newest first, a page at a time; one token's only when given. */
export function useVitals(
  patientId: string,
  { queueTokenId, limit = VITALS_PAGE_SIZE }: { queueTokenId?: string; limit?: number } = {},
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: triageKeys.list(tenantId ?? '', { patientId, queueTokenId, limit }),
    queryFn: ({ pageParam, signal }) =>
      fetchVitals({ patientId, queueTokenId, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && patientId !== '',
  });
}

/** One reading, to start a correction from. */
export function useReading(patientId: string, vitalsId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: reading(tenantId ?? '', patientId, vitalsId),
    queryFn: ({ signal }) => fetchReading(patientId, vitalsId, signal),
    enabled: tenantId !== undefined && patientId !== '' && vitalsId !== '',
  });
}

/** The ranges that apply to the patient. They change rarely: read once a screen. */
export function useVitalRanges(patientId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: ranges(tenantId ?? '', patientId),
    queryFn: ({ signal }) => fetchVitalRanges(patientId, signal),
    enabled: tenantId !== undefined && patientId !== '',
    staleTime: 5 * 60_000,
  });
}

export function useAllergies(patientId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: allergies(tenantId ?? '', patientId),
    queryFn: ({ signal }) => fetchAllergies(patientId, signal),
    enabled: enabled && tenantId !== undefined && patientId !== '',
  });
}

/** Whether the session is still this person's at this hospital, so an answer may go in the cache. */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined && session?.activeTenant?.id === tenantId ? tenantId : undefined;
  };
}

/**
 * Records a reading. A key per request body: an identical resubmit (a double click, a retry) is
 * recorded once, while another body gets a new key. Whatever the answer, the patient's readings
 * are read again.
 */
export function useRecordVitals(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const keyFor = (body: VitalsCreate) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: (body: VitalsCreate) => recordVitals(patientId, body, keyFor(body)),
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: triageKeys.all(tenantId) });
    },
  });
}

/**
 * Saves the allergies from the version the edit started from. The answer replaces what is held,
 * unless the session ended or moved to another hospital meanwhile; a conflict reads them again.
 */
export function useSaveAllergies(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: AllergyListUpdate) => saveAllergies(patientId, body),
    onSuccess: (saved) => {
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(allergies(tenantId, patientId), saved);
    },
    onError: () => {
      const tenantId = stillHere();
      if (tenantId)
        return queryClient.invalidateQueries({ queryKey: allergies(tenantId, patientId) });
    },
  });
}
