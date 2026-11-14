import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { inventoryKeys } from '@/features/inventory';
import { createTenantKeys } from '@/shared/api';
import { dayBoundsUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import {
  addAddendum,
  bookSurgery,
  fetchConsumables,
  fetchOperation,
  linkEncounter,
  recordConsumables,
  returnConsumable,
  saveOperationNote,
  signOperationNote,
  type RecordConsumables,
  type ReturnConsumable,
  createRoom,
  fetchRooms,
  fetchSurgeries,
  completeStep,
  fetchPeriop,
  moveSurgery,
  recordFitness,
  saveAnaesthesia,
  signAnaesthesia,
  rescheduleSurgery,
  updateRoom,
  type MoveSurgery,
} from '../api';
import { PAGE_SIZE } from '../schemas';
import type {
  AnaesthesiaInput,
  ChecklistStepCode,
  OperationNoteInput,
  OperationRecord,
  PeriopRecord,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's theatres never show in another. */
export const roomKeys = createTenantKeys('ot-rooms');
export const surgeryKeys = createTenantKeys('surgeries');

/** The day is read again this often: the theatre desk and the ward share it. */
export const REFRESH_MS = 30_000;

/** The hospital's theatres (the first 100), archived ones too so a past booking is named. */
export function useRooms() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: roomKeys.list(tenantId ?? '', { limit: 100 }),
    queryFn: ({ signal }) => fetchRooms({ limit: 100 }, signal),
    enabled: tenantId !== undefined,
    select: (page) => page.items,
  });
}

/** One hospital day's surgeries, from the hospital's own midnight to the next. */
export function useDaySurgeries(day: string, roomId: string | undefined) {
  const tenant = useTenant();
  const tenantId = tenant?.id;
  const timezone = tenant?.timezone ?? 'UTC';
  const { start, end } = dayBoundsUtc(day, timezone);
  return useInfiniteQuery({
    queryKey: surgeryKeys.list(tenantId ?? '', { from: start, to: end, roomId, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchSurgeries({ from: start, to: end, roomId, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
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

function useRefresh(which: 'surgeries' | 'rooms') {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    const keys = which === 'rooms' ? roomKeys : surgeryKeys;
    void queryClient.invalidateQueries({ queryKey: keys.all(tenantId) });
  };
}

export function useBookSurgery() {
  const attempt = useAttempt();
  const refresh = useRefresh('surgeries');
  return useMutation({
    gcTime: 0,
    mutationFn: (body: Parameters<typeof bookSurgery>[0]) =>
      bookSurgery(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useRescheduleSurgery() {
  const attempt = useAttempt();
  const refresh = useRefresh('surgeries');
  return useMutation({
    gcTime: 0,
    mutationFn: (change: Parameters<typeof rescheduleSurgery>[0]) =>
      rescheduleSurgery(
        change,
        attempt.keyFor([
          change.surgery.id,
          change.surgery.version,
          change.roomId,
          change.surgeonId,
          change.startsAt,
          change.endsAt,
        ]),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useMoveSurgery() {
  const attempt = useAttempt();
  const refresh = useRefresh('surgeries');
  return useMutation({
    gcTime: 0,
    mutationFn: (move: MoveSurgery) =>
      moveSurgery(move, attempt.keyFor([move.surgery.id, move.surgery.version, move.to])),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useCreateRoom() {
  const attempt = useAttempt();
  const refresh = useRefresh('rooms');
  return useMutation({
    gcTime: 0,
    mutationFn: (body: Parameters<typeof createRoom>[0]) => createRoom(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useUpdateRoom() {
  const refresh = useRefresh('rooms');
  return useMutation({
    gcTime: 0,
    mutationFn: updateRoom,
    onSettled: refresh,
  });
}

export const periopKeys = createTenantKeys('periop');

/** The pre-operative record of one surgery. Another person may be ticking steps, so it is re-read. */
export function usePeriop(surgeryId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: periopKeys.detail(tenantId ?? '', surgeryId),
    queryFn: ({ signal }) => fetchPeriop(surgeryId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** Every change answers with the whole record, which replaces what is cached. */
function usePeriopWrite<Input>(
  surgeryId: string,
  write: (input: Input, key: string) => Promise<PeriopRecord>,
  identity: (input: Input) => unknown,
) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Input) => write(input, attempt.keyFor([surgeryId, identity(input)])),
    onSuccess: (record) => {
      attempt.done();
      if (tenantId) queryClient.setQueryData(periopKeys.detail(tenantId, surgeryId), record);
    },
  });
}

export const useRecordFitness = (surgeryId: string) =>
  usePeriopWrite(
    surgeryId,
    (body: Parameters<typeof recordFitness>[1]) => recordFitness(surgeryId, body),
    (body) => body,
  );
export const useCompleteStep = (surgeryId: string) =>
  usePeriopWrite(
    surgeryId,
    (change: { step: ChecklistStepCode; note?: string }, key) =>
      completeStep({ surgeryId, ...change }, key),
    (change) => change,
  );
export const useSaveAnaesthesia = (surgeryId: string) =>
  usePeriopWrite(
    surgeryId,
    (body: AnaesthesiaInput) => saveAnaesthesia(surgeryId, body),
    (body) => body,
  );
export const useSignAnaesthesia = (surgeryId: string) =>
  usePeriopWrite(
    surgeryId,
    (_: void, key) => signAnaesthesia(surgeryId, key),
    () => 'sign',
  );

export const operationKeys = createTenantKeys('operation');
export const consumableKeys = createTenantKeys('ot-consumables');

/** The operation note of one surgery and the visit it is charged to. */
export function useOperation(surgeryId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: operationKeys.detail(tenantId ?? '', surgeryId),
    queryFn: ({ signal }) => fetchOperation(surgeryId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** Every change answers with the whole record, which replaces what is cached. */
function useOperationWrite<Input>(
  surgeryId: string,
  write: (input: Input, key: string) => Promise<OperationRecord>,
  identity: (input: Input) => unknown,
  { changesSurgery = false } = {},
) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Input) => write(input, attempt.keyFor([surgeryId, identity(input)])),
    onSuccess: (record) => {
      attempt.done();
      if (!tenantId) return;
      queryClient.setQueryData(operationKeys.detail(tenantId, surgeryId), record);
      // Linking a visit changes the surgery's version, which the day's list carries.
      if (changesSurgery) {
        void queryClient.invalidateQueries({ queryKey: surgeryKeys.all(tenantId) });
      }
    },
  });
}

export const useSaveOperationNote = (surgeryId: string) =>
  useOperationWrite(
    surgeryId,
    (body: OperationNoteInput) => saveOperationNote(surgeryId, body),
    (body) => body,
  );
export const useSignOperationNote = (surgeryId: string) =>
  useOperationWrite(
    surgeryId,
    (_: void, key) => signOperationNote(surgeryId, key),
    () => 'sign',
  );
export const useAddAddendum = (surgeryId: string) =>
  useOperationWrite(
    surgeryId,
    (text: string, key) => addAddendum({ surgeryId, text }, key),
    (text) => text,
  );
export const useLinkEncounter = (surgeryId: string) =>
  useOperationWrite(
    surgeryId,
    (encounterId: string) => linkEncounter(surgeryId, encounterId),
    (encounterId) => encounterId,
    { changesSurgery: true },
  );

export const CONSUMABLES_PAGE = 50;

/** What was used in the surgery, oldest first, a page at a time. */
export function useConsumables(surgeryId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: consumableKeys.list(tenantId ?? '', { surgeryId, limit: CONSUMABLES_PAGE }),
    queryFn: ({ pageParam, signal }) =>
      fetchConsumables(surgeryId, { cursor: pageParam, limit: CONSUMABLES_PAGE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
  });
}

/** Records stock used; the stock lists of the inventory screens are read again. */
export function useRecordConsumables() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: RecordConsumables) => recordConsumables(input, attempt.keyFor(input)),
    onSuccess: () => attempt.done(),
    onSettled: () => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({ queryKey: consumableKeys.all(tenantId) });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all(tenantId) });
    },
  });
}

/** Returns units of a recorded consumable to stock; the used list and the stock are read again. */
export function useReturnConsumable() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: ReturnConsumable) => returnConsumable(input, attempt.keyFor(input)),
    onSuccess: () => attempt.done(),
    onSettled: () => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({ queryKey: consumableKeys.all(tenantId) });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all(tenantId) });
    },
  });
}
