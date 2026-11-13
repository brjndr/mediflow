import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchSplit, saveSplit } from '../split';
import { coverageKeys } from './use-coverage';

/** The split of one visit. A visit whose patient has no active policy answers 404: no split. */
export function useCoverageSplit(encounterId: string, enabled = true) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: coverageKeys.detail(tenantId ?? '', `split:${encounterId}`),
    queryFn: ({ signal }) => fetchSplit(encounterId, signal),
    enabled: enabled && tenantId !== undefined && encounterId !== '',
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
    // The ledger moves while the desk works.
    refetchOnWindowFocus: true,
  });
}

/** One key until a save is answered, so a second tap is the same request. */
export function useSaveSplit(encounterId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const key = useRef<string>(undefined);
  return useMutation({
    gcTime: 0,
    mutationFn: () => {
      key.current ??= crypto.randomUUID();
      return saveSplit(encounterId, key.current);
    },
    onSuccess: () => {
      key.current = undefined;
    },
    onSettled: () => {
      if (tenantId) void queryClient.invalidateQueries({ queryKey: coverageKeys.all(tenantId) });
    },
  });
}
