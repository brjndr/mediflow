import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  addReactionUpdate,
  deferDonor,
  fetchDonor,
  fetchDonorTrace,
  recordCollection,
  registerDonor,
  updateDonor,
  searchDonors,
  setPatientBloodGroup,
  type DonorFilters,
  fetchCompatibleUnits,
  fetchPatientBloodGroup,
  fetchStock,
  fetchTrace,
  fetchUnit,
  fetchUnits,
  moveUnit,
  recordCrossmatch,
  recordReaction,
  recordScreening,
  registerUnit,
  type UnitFilters,
  type UnitMove,
} from '../api';
import { DONOR_PAGE_SIZE } from '../donor-schemas';
import type {
  BloodCollectionCreate,
  BloodDonorCreate,
  BloodDonorDefer,
  BloodDonorUpdate,
  PatientBloodGroupSet,
  BloodComponent,
  BloodScreeningCreate,
  BloodUnitCreate,
  CrossmatchResult,
  ReactionSeverity,
  TransfusionReactionCreate,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's blood never shows in another. */
export const bloodKeys = createTenantKeys('blood-units');

export const UNIT_PAGE_SIZE = 50;

/** Others reserve and issue the same units, so the screen reads again this often. */
export const REFRESH_MS = 20_000;

export function useUnits(filters: UnitFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: bloodKeys.list(tenantId ?? '', { ...filters, limit: UNIT_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchUnits({ filters, cursor: pageParam, limit: UNIT_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useStock() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', 'stock'),
    queryFn: ({ signal }) => fetchStock(signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

export function useUnitHistory(unitId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', unitId),
    queryFn: ({ signal }) => fetchUnit(unitId, signal),
    enabled: tenantId !== undefined,
  });
}

/** Retrying the same request with the same body sends the same key, so it happens once. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor(body: string) {
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return attempt.current.key;
    },
    done() {
      attempt.current = undefined;
    },
  };
}

function useRefreshAll() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) return queryClient.invalidateQueries({ queryKey: bloodKeys.all(tenantId) });
  };
}

/** Not shown before the server answers: another person may have moved the unit first (409). */
export function useMoveUnit() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (move: UnitMove) =>
      moveUnit(
        move,
        attempt.keyFor(
          JSON.stringify([move.unit.id, move.unit.version, move.to, move.patientId, move.reason]),
        ),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useRegisterUnit() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: BloodUnitCreate) => registerUnit(body, attempt.keyFor(JSON.stringify(body))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useScreening() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ unitId, body }: { unitId: string; body: BloodScreeningCreate }) =>
      recordScreening(unitId, body, attempt.keyFor(JSON.stringify([unitId, body]))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useCrossmatch() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { unitId: string; patientId: string; result: CrossmatchResult }) =>
      recordCrossmatch(
        input.unitId,
        { patientId: input.patientId, result: input.result },
        attempt.keyFor(JSON.stringify(input)),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/** Available units that fit a patient, read again whenever a unit or a cross-match changes. */
export function useCompatibleUnits(patientId: string | undefined, component: BloodComponent) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.list(tenantId ?? '', { kind: 'compatible', patientId, component }),
    queryFn: ({ signal }) =>
      fetchCompatibleUnits({ patientId: patientId ?? '', component }, signal),
    enabled: tenantId !== undefined && patientId !== undefined,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}

/** The patient's blood group, shown beside a cross-match. Not every caller may read it. */
export function usePatientBloodGroup(patientId: string | undefined) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', `group:${patientId}`),
    queryFn: ({ signal }) => fetchPatientBloodGroup(patientId ?? '', signal),
    enabled: tenantId !== undefined && patientId !== undefined,
    retry: false,
  });
}

export function useRecordReaction() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: TransfusionReactionCreate) =>
      recordReaction(body, attempt.keyFor(JSON.stringify(body))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useReactionUpdate() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { reactionId: string; note: string; severity?: ReactionSeverity }) =>
      addReactionUpdate(
        input.reactionId,
        { note: input.note, ...(input.severity ? { severity: input.severity } : {}) },
        attempt.keyFor(JSON.stringify(input)),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useTrace(unitId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', `trace:${unitId}`),
    queryFn: ({ signal }) => fetchTrace(unitId, signal),
    enabled: tenantId !== undefined,
  });
}

export function useDonors(filters: DonorFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: bloodKeys.list(tenantId ?? '', { kind: 'donors', ...filters }),
    queryFn: ({ pageParam, signal }) =>
      searchDonors({ filters, cursor: pageParam, limit: DONOR_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The full record of one donor: opening it is audited on the server, so only a dialog asks. */
export function useDonor(donorId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', `donor:${donorId}`),
    queryFn: ({ signal }) => fetchDonor(donorId, signal),
    enabled: tenantId !== undefined,
    // Another read is another audited read: a dialog opened twice reads it again, once.
    gcTime: 0,
  });
}

export function useDonorTrace(donorId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: bloodKeys.detail(tenantId ?? '', `donor-trace:${donorId}`),
    queryFn: ({ signal }) => fetchDonorTrace(donorId, signal),
    enabled: tenantId !== undefined && enabled,
    gcTime: 0,
    retry: false,
  });
}

export function useRegisterDonor() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: BloodDonorCreate) =>
      registerDonor(body, attempt.keyFor(JSON.stringify(body))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/** A correction is not retried blindly: the version in the body makes a second send a conflict. */
export function useUpdateDonor() {
  const refresh = useRefreshAll();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { donorId: string; body: BloodDonorUpdate }) =>
      updateDonor(input.donorId, input.body),
    onSettled: refresh,
  });
}

export function useDeferDonor() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { donorId: string; body: BloodDonorDefer }) =>
      deferDonor(input.donorId, input.body, attempt.keyFor(JSON.stringify(input))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

/** Records a donation. The units it makes join the unit list, so every blood query is read again. */
export function useRecordCollection() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: BloodCollectionCreate) =>
      recordCollection(body, attempt.keyFor(JSON.stringify(body))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useSetPatientBloodGroup() {
  const refresh = useRefreshAll();
  const attempt = useAttempt();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: { patientId: string; body: PatientBloodGroupSet }) =>
      setPatientBloodGroup(input.patientId, input.body, attempt.keyFor(JSON.stringify(input))),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}
