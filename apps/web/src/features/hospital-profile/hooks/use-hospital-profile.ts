import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionKey } from '@/app/session/session-query';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchHospitalProfile, updateHospitalProfile } from '../api';
import type { HospitalProfileUpdate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's details never show in another. */
export const hospitalProfileKeys = createTenantKeys('hospital-profile');

export function useHospitalProfile() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: hospitalProfileKeys.detail(tenantId ?? '', 'self'),
    queryFn: ({ signal }) => fetchHospitalProfile(signal),
    enabled: tenantId !== undefined,
  });
}

/**
 * Saves the details. The letterhead reads them from the session, so a saved change refreshes it:
 * the next print shows them. Also after a failure, since a conflict means the screen is stale.
 */
export function useSaveHospitalProfile() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: (body: HospitalProfileUpdate) => updateHospitalProfile(body),
    onSettled: async (_saved, error) => {
      if (tenantId) {
        await queryClient.invalidateQueries({
          queryKey: hospitalProfileKeys.detail(tenantId, 'self'),
        });
      }
      if (!error) await queryClient.invalidateQueries({ queryKey: sessionKey });
    },
  });
}
