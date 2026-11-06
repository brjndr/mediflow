import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionKey, type Session } from '@/app/session';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchDrug, fetchFavouriteDrugs, putFavouriteDrugs } from '../api';
import { FAVOURITES_MAX } from '../schemas';
import type { FavouriteDrugs } from '../types';
import { drugKeys } from './use-drugs';

const favouritesKey = (tenantId: string) => drugKeys.detail(tenantId, 'favourites');

/**
 * What this person may do with favourite medicines: they belong to the prescription sets API,
 * behind the clinical switch (#394). Without the permission nothing is asked of the server.
 */
export function useFavouriteAccess() {
  const switchedOn = useFeatureFlag('clinical');
  const canRead = usePermission('prescriptionSet:read') && switchedOn;
  const canManage = usePermission('prescriptionSet:manage') && canRead;
  return { canRead, canManage };
}

/** The caller's favourite medicines, in the order they put them. Not asked unless `enabled`. */
export function useFavouriteDrugs(enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: favouritesKey(tenantId ?? ''),
    queryFn: ({ signal }) => fetchFavouriteDrugs(signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: 60_000,
  });
}

/** Replaces the list with one more or one fewer medicine. */
export function useToggleFavourite() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    gcTime: 0,
    mutationFn: async ({ drugId, starred }: { drugId: string; starred: boolean }) => {
      // From the server's list, not the screen's: two tabs do not undo each other's stars.
      const current = await fetchFavouriteDrugs();
      const ids = current.items.map((item) => item.drugId).filter((id) => id !== drugId);
      return putFavouriteDrugs(starred ? [...ids, drugId].slice(-FAVOURITES_MAX) : ids);
    },
    onSuccess: (saved: FavouriteDrugs) => {
      // Nothing is written if the answer arrives after the session ended or moved on.
      const session = queryClient.getQueryData<Session | null>(sessionKey);
      if (!tenantId || session?.activeTenant?.id !== tenantId) return;
      queryClient.setQueryData(favouritesKey(tenantId), saved);
    },
    onError: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: favouritesKey(tenantId) });
    },
  });
}

/** One medicine of the catalog by its id, for a favourite that was chosen. */
export const loadDrug = (drugId: string) => fetchDrug(drugId);
