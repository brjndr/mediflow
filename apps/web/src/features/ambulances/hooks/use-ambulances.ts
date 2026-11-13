import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createAmbulance,
  fetchAmbulances,
  fetchTrips,
  moveTrip,
  requestTrip,
  setService,
  type TripMove,
} from '../api';
import { PAGE_SIZE } from '../schemas';
import type { Ambulance, AmbulanceStatus, TripStatus } from '../types';

/** Every key is prefixed with the tenant, so one hospital's fleet never shows in another. */
export const ambulanceKeys = createTenantKeys('ambulances');
export const tripKeys = createTenantKeys('ambulance-trips');

/** The lists are read again this often: dispatchers share them. */
export const REFRESH_MS = 15_000;

export function useTrips(status: TripStatus | undefined) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: tripKeys.list(tenantId ?? '', { status, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchTrips({ status, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useAmbulances(status?: AmbulanceStatus) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: ambulanceKeys.list(tenantId ?? '', { status, limit: PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchAmbulances({ status, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

/** The available ambulances a trip can be sent with (first 100). */
export function useAvailableAmbulances() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: ambulanceKeys.list(tenantId ?? '', { status: 'available', options: true }),
    queryFn: ({ signal }) => fetchAmbulances({ status: 'available', limit: 100 }, signal),
    enabled: tenantId !== undefined,
    select: (page) => page.items,
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

/** A trip moving frees or takes an ambulance, so both lists are read again. */
function useRefreshBoth() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({ queryKey: tripKeys.all(tenantId) });
    void queryClient.invalidateQueries({ queryKey: ambulanceKeys.all(tenantId) });
  };
}

export function useRequestTrip() {
  const attempt = useAttempt();
  const refresh = useRefreshBoth();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: Parameters<typeof requestTrip>[0]) =>
      requestTrip(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useMoveTrip() {
  const attempt = useAttempt();
  const refresh = useRefreshBoth();
  return useMutation({
    gcTime: 0,
    mutationFn: (move: TripMove) =>
      moveTrip(
        move,
        attempt.keyFor([move.trip.id, move.trip.version, move.to, move.ambulanceId, move.crew]),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useCreateAmbulance() {
  const attempt = useAttempt();
  const refresh = useRefreshBoth();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: Parameters<typeof createAmbulance>[0]) =>
      createAmbulance(body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useSetService() {
  const attempt = useAttempt();
  const refresh = useRefreshBoth();
  return useMutation({
    gcTime: 0,
    mutationFn: (change: { ambulance: Ambulance; to: 'available' | 'out_of_service' }) =>
      setService(
        change,
        attempt.keyFor([change.ambulance.id, change.ambulance.version, change.to]),
      ),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}
