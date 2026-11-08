import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchStock,
  fetchUnit,
  fetchUnits,
  moveUnit,
  registerUnit,
  type UnitFilters,
  type UnitMove,
} from '../api';
import type { BloodUnitCreate } from '../types';

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
