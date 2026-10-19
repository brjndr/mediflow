import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  amendNote,
  cancelEncounter,
  closeEncounter,
  discardNote,
  fetchDiagnoses,
  fetchEncounter,
  fetchEncounters,
  fetchNotes,
  openEncounter,
  recordDiagnosis,
  retractDiagnosis,
  signNote,
  type EncounterFilters,
} from '../api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import type { DiagnosisCreate, Encounter, EncounterCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's visits never show in another. */
export const clinicalKeys = createTenantKeys('clinical');

const notesKey = (tenantId: string, encounterId: string) =>
  [...clinicalKeys.detail(tenantId, encounterId), 'notes'] as const;
const diagnosesKey = (tenantId: string, encounterId: string) =>
  [...clinicalKeys.detail(tenantId, encounterId), 'diagnoses'] as const;

export const ENCOUNTERS_PAGE_SIZE = 25;
export const RECORDS_PAGE_SIZE = 50;

/**
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
export function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  // The same object every render, so a callback built on it stays the same too.
  return useMemo(
    () => ({
      keyFor(body: unknown) {
        const serialized = JSON.stringify(body);
        if (attempt.current?.body !== serialized) {
          attempt.current = { body: serialized, key: crypto.randomUUID() };
        }
        return attempt.current.key;
      },
      /** After an answer: the next request is a new one, even with the same body. */
      clear() {
        attempt.current = undefined;
      },
    }),
    [],
  );
}

/**
 * The hospital, while the session is still the one the request was made in: the same person at
 * the same hospital. An answer that arrives after a sign-out, a time-out or a switch is never
 * written, so a patient's record does not come back for whoever signs in next on a shared PC.
 */
export function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return useCallback(() => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  }, [queryClient, tenantId, userId]);
}

/** The encounters the caller may see, newest first, a page at a time. */
export function useEncounters(filters: EncounterFilters, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: clinicalKeys.list(tenantId ?? '', { ...filters, limit: ENCOUNTERS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchEncounters({ ...filters, cursor: pageParam, limit: ENCOUNTERS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined,
  });
}

export function useEncounter(encounterId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: clinicalKeys.detail(tenantId ?? '', encounterId),
    queryFn: ({ signal }) => fetchEncounter(encounterId, signal),
    enabled: tenantId !== undefined && encounterId !== '',
  });
}

/** The encounter's signed notes and the caller's own drafts, oldest first. */
export function useNotes(encounterId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: notesKey(tenantId ?? '', encounterId),
    queryFn: ({ pageParam, signal }) =>
      fetchNotes({ encounterId, cursor: pageParam, limit: RECORDS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && encounterId !== '',
  });
}

export function useDiagnoses(encounterId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: diagnosesKey(tenantId ?? '', encounterId),
    queryFn: ({ pageParam, signal }) =>
      fetchDiagnoses({ encounterId, cursor: pageParam, limit: RECORDS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && encounterId !== '',
  });
}

/** Writes an encounter the server answered with, and refreshes the lists it appears in. */
function useEncounterAnswered() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return {
    written(encounter: Encounter) {
      const tenantId = stillHere();
      if (tenantId)
        queryClient.setQueryData(clinicalKeys.detail(tenantId, encounter.id), encounter);
    },
    refreshLists() {
      const tenantId = stillHere();
      if (tenantId)
        return queryClient.invalidateQueries({ queryKey: clinicalKeys.lists(tenantId) });
    },
  };
}

/** Opens the consultation from a token or an appointment, or finds the one already open. */
export function useOpenEncounter() {
  const answered = useEncounterAnswered();
  const keys = useIdempotencyKey();
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the action is gone.
    gcTime: 0,
    mutationFn: (body: EncounterCreate) => openEncounter(body, keys.keyFor(body)),
    onSuccess: (encounter) => {
      keys.clear();
      answered.written(encounter);
    },
    onSettled: () => answered.refreshLists(),
  });
}

export type EncounterChange = { kind: 'close' } | { kind: 'cancel'; reason: string };

/** Closes or cancels, from the version shown. Either way the answer is the encounter as it is. */
export function useChangeEncounter(encounterId: string) {
  const answered = useEncounterAnswered();
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ change, version }: { change: EncounterChange; version: number }) => {
      const key = keys.keyFor({ change, version });
      return change.kind === 'close'
        ? closeEncounter(encounterId, version, key)
        : cancelEncounter(encounterId, { version, reason: change.reason }, key);
    },
    onSuccess: (encounter) => {
      keys.clear();
      answered.written(encounter);
    },
    onError: () => {
      // A conflict or a refusal: what is shown may be out of date.
      const tenantId = stillHere();
      if (tenantId) {
        return queryClient.invalidateQueries({
          queryKey: clinicalKeys.detail(tenantId, encounterId),
        });
      }
    },
    onSettled: () => answered.refreshLists(),
  });
}

/** Reads the encounter's notes again: after one is signed, discarded or amended. */
export function useRefreshNotes(encounterId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId)
      return queryClient.invalidateQueries({ queryKey: notesKey(tenantId, encounterId) });
  };
}

export function useSignNote(encounterId: string) {
  const refresh = useRefreshNotes(encounterId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ noteId, version }: { noteId: string; version: number }) =>
      signNote(noteId, version, keys.keyFor({ noteId, version })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useDiscardNote(encounterId: string) {
  const refresh = useRefreshNotes(encounterId);
  return useMutation({
    gcTime: 0,
    mutationFn: (noteId: string) => discardNote(noteId),
    onSettled: refresh,
  });
}

export function useAmendNote(encounterId: string) {
  const refresh = useRefreshNotes(encounterId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { noteId: string; body: RichTextDocument; reason: string }) =>
      amendNote(input.noteId, { body: input.body, reason: input.reason }, keys.keyFor(input)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

function useRefreshDiagnoses(encounterId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) {
      return queryClient.invalidateQueries({ queryKey: diagnosesKey(tenantId, encounterId) });
    }
  };
}

export function useRecordDiagnosis(encounterId: string) {
  const refresh = useRefreshDiagnoses(encounterId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: DiagnosisCreate) => recordDiagnosis(encounterId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useRetractDiagnosis(encounterId: string) {
  const refresh = useRefreshDiagnoses(encounterId);
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ diagnosisId, reason }: { diagnosisId: string; reason: string }) =>
      retractDiagnosis(diagnosisId, reason, keys.keyFor({ diagnosisId, reason })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
