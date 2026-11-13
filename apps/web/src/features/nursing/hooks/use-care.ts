import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import {
  addCarePlanTask,
  closeCarePlan,
  completeCarePlanTask,
  correctFluid,
  createCarePlan,
  fetchCarePlans,
  fetchFluids,
  fetchFluidTotals,
  recordFluid,
} from '../care-api';
import type { ShiftWindow } from '../shifts';
import type {
  CarePlanCreate,
  CarePlanTaskCreate,
  WardFluid,
  WardFluidCorrect,
  WardFluidCreate,
} from '../types';
import { nursingKeys, REFRESH_MS } from './use-nursing';

export const FLUIDS_PAGE_SIZE = 100;
export const PLANS_PAGE_SIZE = 25;

const fluidKey = (tenantId: string, admissionId: string) =>
  [...nursingKeys.all(tenantId), 'fluids', admissionId] as const;
const planKey = (tenantId: string, admissionId: string) =>
  [...nursingKeys.all(tenantId), 'care-plans', admissionId] as const;

/** The entries of a window, newest first, a page at a time. */
export function useFluids(admissionId: string, window: { from: string; to: string }) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [
      ...fluidKey(tenantId ?? '', admissionId),
      'list',
      window,
      { limit: FLUIDS_PAGE_SIZE },
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchFluids({ admissionId, ...window, cursor: pageParam, limit: FLUIDS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** The totals of each shift, worked out by the server for the window of the shift. */
export function useShiftTotals(admissionId: string, windows: ShiftWindow[]) {
  const tenantId = useTenant()?.id;
  return useQueries({
    queries: windows.map((window) => ({
      queryKey: [...fluidKey(tenantId ?? '', admissionId), 'totals', window.from, window.to],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchFluidTotals(admissionId, window.from, window.to, signal),
      enabled: tenantId !== undefined,
      refetchInterval: REFRESH_MS,
    })),
  });
}

export type FluidSave =
  | { kind: 'record'; body: WardFluidCreate }
  | { kind: 'correct'; entry: WardFluid; body: WardFluidCorrect };

/** One key per request body, so a double click or a retry records the entry once. */
export function useSaveFluid(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (save: FluidSave) => {
      const serialized = JSON.stringify(save);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const { key } = attempt.current;
      return save.kind === 'record'
        ? recordFluid(admissionId, save.body, key)
        : correctFluid(admissionId, save.entry.id, save.body, key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: fluidKey(tenantId, admissionId) });
      }
    },
  });
}

export function useCarePlans(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...planKey(tenantId ?? '', admissionId), { limit: PLANS_PAGE_SIZE }],
    queryFn: ({ pageParam, signal }) =>
      fetchCarePlans({ admissionId, cursor: pageParam, limit: PLANS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** Starts a plan; one key per body, so a retry starts it once. */
export function useCreateCarePlan(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (body: CarePlanCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createCarePlan(admissionId, body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: planKey(tenantId, admissionId) });
      }
    },
  });
}

export type PlanChange =
  | { kind: 'addTask'; planId: string; body: CarePlanTaskCreate }
  | { kind: 'done'; taskId: string; note?: string }
  | { kind: 'close'; planId: string; status: 'completed' | 'cancelled' };

/** Adds a task, marks one done, or ends a plan. Adding sends one key per body. */
export function useChangeCarePlan(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (change: PlanChange) => {
      if (change.kind === 'done') return completeCarePlanTask(change.taskId, change.note);
      if (change.kind === 'close') return closeCarePlan(change.planId, change.status);
      const serialized = JSON.stringify(change);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return addCarePlanTask(change.planId, change.body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: planKey(tenantId, admissionId) });
      }
    },
  });
}
