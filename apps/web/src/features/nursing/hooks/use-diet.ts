import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import { fetchKitchenList, fetchStayDiet, placeDietOrder } from '../diet-api';
import { nursingKeys, REFRESH_MS } from './use-nursing';

export const KITCHEN_PAGE_SIZE = 100;

const dietKey = (tenantId: string) => [...nursingKeys.all(tenantId), 'diet'] as const;

/** The kitchen list, read again often so it shows the latest orders. */
export function useKitchenList(wardId: string) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: [...dietKey(tenantId ?? ''), 'kitchen', { wardId, limit: KITCHEN_PAGE_SIZE }],
    queryFn: ({ pageParam, signal }) =>
      fetchKitchenList({ wardId, cursor: pageParam, limit: KITCHEN_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useStayDiet(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...dietKey(tenantId ?? ''), 'stay', admissionId],
    queryFn: ({ signal }) => fetchStayDiet(admissionId, signal),
    enabled: tenantId !== undefined,
    refetchInterval: REFRESH_MS,
  });
}

/** Places a diet order; one key per body, so a retry places it once. */
export function usePlaceDiet(encounterId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: (body: { instructions: string; priority: 'routine' | 'urgent' }) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return placeDietOrder(encounterId, body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: dietKey(tenantId) });
    },
  });
}
