import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { useAppointmentsChanged } from '@/features/appointments';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  bookFollowUp,
  cancelFollowUp,
  createFollowUp,
  fetchEncounterFollowUps,
  fetchFollowUps,
  type DueListFilters,
} from '../api';
import type { FollowUp, FollowUpBook, FollowUpCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's follow-ups never show in another. */
export const followUpKeys = createTenantKeys('follow_ups');

const encounterKey = (tenantId: string, encounterId: string) =>
  [...followUpKeys.all(tenantId), 'encounter', encounterId] as const;

export const DUE_LIST_PAGE_SIZE = 25;
const ENCOUNTER_PAGE_SIZE = 50;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
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
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMemo(
    () => ({
      keyFor(body: unknown) {
        const serialized = JSON.stringify(body);
        if (attempt.current?.body !== serialized) {
          attempt.current = { body: serialized, key: crypto.randomUUID() };
        }
        return attempt.current.key;
      },
      clear() {
        attempt.current = undefined;
      },
    }),
    [],
  );
}

/** The due list: the hospital's follow-ups the caller may see, the soonest first. */
export function useFollowUps(filters: DueListFilters, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: followUpKeys.list(tenantId ?? '', { ...filters, limit: DUE_LIST_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchFollowUps({ ...filters, cursor: pageParam, limit: DUE_LIST_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined,
  });
}

/** The encounter's follow-ups, cancelled ones included. */
export function useEncounterFollowUps(encounterId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: encounterKey(tenantId ?? '', encounterId),
    queryFn: ({ pageParam, signal }) =>
      fetchEncounterFollowUps(
        { encounterId, cursor: pageParam, limit: ENCOUNTER_PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && encounterId !== '',
  });
}

/** Whatever the answer, every follow-up held (the due list and the encounter's) is read again. */
function useRefreshFollowUps() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: followUpKeys.all(tenantId) });
  };
}

export function useCreateFollowUp(encounterId: string) {
  const refresh = useRefreshFollowUps();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: (body: FollowUpCreate) => createFollowUp(encounterId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/**
 * Books a follow-up as an appointment. Booked or refused, the appointments and their free times
 * have changed too: a refusal means someone else took the time.
 */
export function useBookFollowUp() {
  const refresh = useRefreshFollowUps();
  const appointmentsChanged = useAppointmentsChanged();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ followUp, body }: { followUp: FollowUp; body: FollowUpBook }) =>
      bookFollowUp(followUp.id, body, keys.keyFor({ id: followUp.id, ...body })),
    onSuccess: () => keys.clear(),
    // Not waited for: the screen closes its panel on the answer before the list shows it booked.
    onSettled: () => {
      void Promise.all([refresh(), appointmentsChanged()]);
    },
  });
}

export function useCancelFollowUp() {
  const refresh = useRefreshFollowUps();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ followUp, reason }: { followUp: FollowUp; reason: string }) => {
      const body = { reason, version: followUp.version };
      return cancelFollowUp(followUp.id, body, keys.keyFor({ id: followUp.id, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
