import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeatureFlag, usePermission } from '@/access';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { createPrescriptionSet, fetchPrescriptionSet, fetchPrescriptionSets } from '../sets-api';
import type { PrescriptionSetCreate } from '../types';
import { useIdempotencyKey, useStillHere } from './use-clinical';

/** Every key is prefixed with the tenant, so one hospital's sets never show in another. */
export const setKeys = createTenantKeys('prescription-sets');

/** What this person may do with prescription sets. The API checks the same. */
export function useSetAccess() {
  const switchedOn = useFeatureFlag('clinical');
  const canRead = usePermission('prescriptionSet:read') && switchedOn;
  const canManage = usePermission('prescriptionSet:manage') && canRead;
  const canShare = usePermission('prescriptionSet:manageShared') && canManage;
  return { canRead, canManage, canShare };
}

/** The sets the caller may use. Asked only while the list is wanted. */
export function usePrescriptionSets(enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: setKeys.lists(tenantId ?? ''),
    queryFn: ({ signal }) => fetchPrescriptionSets(signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: 30_000,
  });
}

/** One set with its lines, read afresh when it is loaded so a changed set is never loaded stale. */
export function useLoadPrescriptionSet() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return (setId: string) =>
    queryClient.fetchQuery({
      queryKey: setKeys.detail(tenantId ?? '', setId),
      queryFn: ({ signal }) => fetchPrescriptionSet(setId, signal),
      staleTime: 0,
    });
}

/** Saves the lines of a form as a set. A repeat of the same body is added once. */
export function useSavePrescriptionSet() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PrescriptionSetCreate) => createPrescriptionSet(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: () => {
      const tenantId = stillHere();
      if (tenantId) return queryClient.invalidateQueries({ queryKey: setKeys.lists(tenantId) });
    },
  });
}
