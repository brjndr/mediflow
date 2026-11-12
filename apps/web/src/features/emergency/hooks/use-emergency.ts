import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  addNote,
  disposeCase,
  fetchCase,
  fetchCases,
  fetchMlc,
  fetchNotes,
  identifyCase,
  openEncounter,
  printMlc,
  registerCase,
  saveMlc,
  startTreatment,
  triageCase,
} from '../api';
import { PAGE_SIZE } from '../schemas';
import type {
  EmergencyCase,
  EmergencyCaseCreate,
  EmergencyCaseStatus,
  EmergencyDisposition,
  EmergencyMlc,
  EmergencyMlcSave,
  EmergencyNoteKind,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's board never shows in another. */
export const emergencyKeys = createTenantKeys('emergency-cases');

/** The board is read again this often: the whole department looks at it. */
export const REFRESH_MS = 10_000;

export function useCases(status: EmergencyCaseStatus | undefined) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: emergencyKeys.list(tenantId ?? '', { status, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchCases({ status, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The clock the waiting times are drawn from, moved on every `everyMs`. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor: (body: unknown) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done: () => {
      attempt.current = undefined;
    },
  };
}

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) void queryClient.invalidateQueries({ queryKey: emergencyKeys.all(tenantId) });
  };
}

export function useRegisterCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: EmergencyCaseCreate) => registerCase(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useTriageCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { row: EmergencyCase; category: number }) =>
      triageCase(change, attempt.keyFor([change.row.id, change.row.version, change.category])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useIdentifyCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { row: EmergencyCase; patientId: string }) =>
      identifyCase(change, attempt.keyFor([change.row.id, change.row.version, change.patientId])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/** One case, read again while its screen is open: others work on it too. */
export function useCase(caseId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: emergencyKeys.detail(tenantId ?? '', caseId),
    queryFn: ({ signal }) => fetchCase(caseId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

const NOTES_PAGE_SIZE = 50;
export function useNotes(caseId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: emergencyKeys.list(tenantId ?? '', { notesOf: caseId, limit: NOTES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchNotes({ caseId, cursor: pageParam, limit: NOTES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

export function useStartTreatment() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (row: EmergencyCase) =>
      startTreatment(row, attempt.keyFor([row.id, row.version, 'start'])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useOpenEncounter() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (row: EmergencyCase) =>
      openEncounter(row, attempt.keyFor([row.id, row.version, 'encounter'])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useAddNote() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (note: { caseId: string; kind: EmergencyNoteKind; body: string }) =>
      addNote(note, attempt.keyFor(note)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useDisposeCase() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { row: EmergencyCase } & Omit<EmergencyDisposition, 'version'>) =>
      disposeCase(change, attempt.keyFor([change.row.id, change.row.version, change])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/**
 * The medico-legal record. Not retried and not refreshed on a timer: every read is audited, so it
 * is read when the panel opens and after a save, not in the background.
 */
export function useMlc(caseId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: emergencyKeys.detail(tenantId ?? '', `${caseId}:medico-legal`),
    queryFn: ({ signal }) => fetchMlc(caseId, signal),
    enabled: enabled && tenantId !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useSaveMlc() {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { caseId: string } & EmergencyMlcSave) =>
      saveMlc(change, attempt.keyFor(change)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/**
 * A print of the medico-legal record: the server records it and answers the revision to print,
 * with a new idempotency key per press; the page is shown (`job`) only then, and held in memory
 * only. `done` drops it when the print dialog closes. Leaving the page aborts the request.
 */
export function useMlcPrinting(caseId: string) {
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const [job, setJob] = useState<{ id: number; value: EmergencyMlc } | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: () => {
      abort.current = new AbortController();
      return printMlc(caseId, crypto.randomUUID(), abort.current.signal);
    },
    onSuccess: (value) => {
      if (!abort.current?.signal.aborted) setJob((now) => ({ id: (now?.id ?? 0) + 1, value }));
    },
  });
  const { isPending, mutate } = mutation;
  const print = useCallback(() => {
    if (!isPending) mutate();
  }, [isPending, mutate]);
  const done = useCallback(() => setJob(null), []);
  return { print, busy: isPending, error: mutation.error, job, done };
}
