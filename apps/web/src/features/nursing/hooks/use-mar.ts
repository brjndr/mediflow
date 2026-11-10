import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import { correctMarEntry, fetchMarEntries, fetchMarOrders, recordMarEntry } from '../api';
import type { MarEntry, MarEntryCorrect, MarEntryCreate } from '../types';
import { nursingKeys, REFRESH_MS } from './use-nursing';

export const MAR_PAGE_SIZE = 100;

const marKey = (tenantId: string, admissionId: string) =>
  [...nursingKeys.all(tenantId), 'mar', admissionId] as const;

export function useMarOrders(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...marKey(tenantId ?? '', admissionId), 'orders'],
    queryFn: ({ signal }) => fetchMarOrders(admissionId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** The chart's entries, newest due first, a page at a time. */
export function useMarEntries(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...marKey(tenantId ?? '', admissionId), 'entries', { limit: MAR_PAGE_SIZE }],
    queryFn: ({ pageParam, signal }) =>
      fetchMarEntries({ admissionId, cursor: pageParam, limit: MAR_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

export type MarSave =
  | { kind: 'record'; body: MarEntryCreate }
  | { kind: 'amend'; entry: MarEntry; body: MarEntryCorrect };

/** One key per request body, so a double click or a retry charts the dose once. */
export function useSaveMar(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (save: MarSave) => {
      const serialized = JSON.stringify(save);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const { key } = attempt.current;
      return save.kind === 'record'
        ? recordMarEntry(save.body, key)
        : correctMarEntry(save.entry.id, save.body, key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) {
        return queryClient.invalidateQueries({ queryKey: marKey(tenantId, admissionId) });
      }
    },
  });
}
