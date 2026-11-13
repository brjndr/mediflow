import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  correctVitals,
  fetchStay,
  fetchStays,
  fetchVitals,
  fetchWardOptions,
  recordVitals,
} from '../api';
import { DEFAULT_EWS_CONFIG, type EwsConfig } from '../ews';
import type { WardVital, WardVitalCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's ward never shows in another. */
export const nursingKeys = createTenantKeys('nursing');

export const STAYS_PAGE_SIZE = 50;
export const VITALS_PAGE_SIZE = 50;
/** The ward changes all day: the list and the chart are read again this often. */
export const REFRESH_MS = 30_000;

/**
 * The hospital's early warning score. The settings are not delivered with the tenant config yet
 * (`nursingSettingsSchema` is ready for them), so every hospital has the defaults.
 */
export function useEwsConfig(): EwsConfig {
  return DEFAULT_EWS_CONFIG;
}

export function useStays(wardId: string, doctorId = '', enabled = true) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: nursingKeys.list(tenantId ?? '', { wardId, doctorId, limit: STAYS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchStays({ wardId, doctorId, cursor: pageParam, limit: STAYS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && enabled,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useStay(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: nursingKeys.detail(tenantId ?? '', admissionId),
    queryFn: ({ signal }) => fetchStay(admissionId, signal),
    enabled: tenantId !== undefined,
    retry: false,
  });
}

export function useWardOptions() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: nursingKeys.detail(tenantId ?? '', 'wards'),
    queryFn: ({ signal }) => fetchWardOptions(signal),
    enabled: tenantId !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

const vitalsKey = (tenantId: string, admissionId: string) =>
  [...nursingKeys.all(tenantId), 'vitals', admissionId] as const;

/** The stay's readings, newest first, a page at a time. */
export function useWardVitals(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...vitalsKey(tenantId ?? '', admissionId), { limit: VITALS_PAGE_SIZE }],
    queryFn: ({ pageParam, signal }) =>
      fetchVitals({ admissionId, cursor: pageParam, limit: VITALS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

export type VitalsSave =
  | { kind: 'record'; body: WardVitalCreate }
  | { kind: 'correct'; reading: WardVital; body: WardVitalCreate & { reason: string } };

/** One key per request body, so a double click or a retry records once. */
export function useSaveVitals(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (save: VitalsSave) => {
      const serialized = JSON.stringify(save);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const { key } = attempt.current;
      return save.kind === 'record'
        ? recordVitals(admissionId, save.body, key)
        : correctVitals(admissionId, save.reading.id, save.body, key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: vitalsKey(tenantId, admissionId) });
      }
    },
  });
}
