import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
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

/** Everything held about one patient, so a change to them refreshes only theirs. */
const patientKey = (tenantId: string, patientId: string) =>
  [...triageKeys.all(tenantId), 'patient', patientId] as const;
const listKey = (tenantId: string, patientId: string) =>
  [...patientKey(tenantId, patientId), 'list'] as const;
const readingKey = (tenantId: string, patientId: string) =>
  [...patientKey(tenantId, patientId), 'reading'] as const;
const rangesKey = (tenantId: string, patientId: string) =>
  [...patientKey(tenantId, patientId), 'ranges'] as const;
const allergiesKey = (tenantId: string, patientId: string) =>
  [...patientKey(tenantId, patientId), 'allergies'] as const;

export const VITALS_PAGE_SIZE = 25;

/** The patient's readings, newest first, a page at a time; one token's only when given. */
export function useVitals(
  patientId: string,
  { queueTokenId, limit = VITALS_PAGE_SIZE }: { queueTokenId?: string; limit?: number } = {},
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...listKey(tenantId ?? '', patientId), { queueTokenId, limit }],
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
    queryKey: [...readingKey(tenantId ?? '', patientId), vitalsId],
    queryFn: ({ signal }) => fetchReading(patientId, vitalsId, signal),
    enabled: tenantId !== undefined && patientId !== '' && vitalsId !== '',
  });
}

/** The ranges that apply to the patient. They change rarely: read once a screen. */
export function useVitalRanges(patientId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: rangesKey(tenantId ?? '', patientId),
    queryFn: ({ signal }) => fetchVitalRanges(patientId, signal),
    enabled: tenantId !== undefined && patientId !== '',
    staleTime: 5 * 60_000,
  });
}

export function useAllergies(patientId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: allergiesKey(tenantId ?? '', patientId),
    queryFn: ({ signal }) => fetchAllergies(patientId, signal),
    enabled: enabled && tenantId !== undefined && patientId !== '',
  });
}

/**
 * The hospital, while the session is still the one the request was made in: the same person at
 * the same hospital. An answer that arrives after a sign-out, a time-out or a switch is never
 * written, so a patient's data does not come back for whoever signs in next on a shared PC.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
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
    // The patient's readings only: their allergies and ranges have not changed.
    onSettled: () => {
      const tenantId = stillHere();
      if (!tenantId) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey(tenantId, patientId) }),
        queryClient.invalidateQueries({ queryKey: readingKey(tenantId, patientId) }),
      ]);
    },
  });
}

/**
 * Saves the allergies from the version the edit started from. The answer replaces what is held,
 * unless the session ended or moved meanwhile. After a conflict the panel reads them again itself.
 */
export function useSaveAllergies(patientId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: AllergyListUpdate) => saveAllergies(patientId, body),
    onSuccess: (saved) => {
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(allergiesKey(tenantId, patientId), saved);
    },
  });
}
