import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchRetentionRules, setRetention } from '../api';
import type { DocumentCategory } from '../types';
import { documentKeys } from './use-documents';

const retentionKey = (tenantId: string) => documentKeys.list(tenantId, { retention: true });

/** The hospital's retention rules: seven categories at most, so one read and no paging. */
export function useRetentionRules() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: retentionKey(tenantId ?? ''),
    queryFn: ({ signal }) => fetchRetentionRules(signal),
    enabled: tenantId !== undefined,
  });
}

export function useSetRetention() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: ({ category, years }: { category: DocumentCategory; years: number | null }) =>
      setRetention(category, years),
    // Invalidating is harmless after a switch: the key holds the hospital it was made for.
    onSettled: () =>
      tenantId === undefined
        ? undefined
        : queryClient.invalidateQueries({ queryKey: retentionKey(tenantId) }),
  });
}
