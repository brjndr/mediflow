import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionKey } from '@/app/session';
import { createTenantKeys, isApiError } from '@/shared/api';
import { confirmMfa, enrollMfa, fetchMfaRequirement } from '../api';

const mfaKeys = createTenantKeys('mfa');

/**
 * The hospital switch that offers the authenticator to its staff. Off unless the hospital has it
 * turned on: then there is no set-up screen, no link to it and no requirement.
 */
export const MFA_FEATURE = 'mfa';

/**
 * Whether the active hospital requires an authenticator of this user. Per hospital, since the
 * rule can differ. This only steers the screens, and the server enforces the rule: if the server
 * does not offer the question yet (404) nothing is required, and if it cannot be reached the
 * query fails and the gate lets the person through rather than lock everyone out.
 */
export function useMfaRequirement(tenantId: string, policyVersion: string, enabled: boolean) {
  return useQuery({
    // The policy version moves when the hospital changes a switch, so a refreshed policy (on a
    // timer, or after the server refuses a request) asks again.
    queryKey: [...mfaKeys.all(tenantId), 'requirement', policyVersion] as const,
    queryFn: async ({ signal }) => {
      try {
        return await fetchMfaRequirement(signal);
      } catch (error) {
        // Any other failure is not an answer, so it is not stored as one: the gate asks again.
        if (isApiError(error) && error.code === 'not_found') return false;
        throw error;
      }
    },
    enabled,
    // A new policy version asks again, and until the answer comes the last one for this hospital
    // stands: the app must not be taken away from someone in the middle of a form.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
    retry: 1,
    retryDelay: 500,
    staleTime: 5 * 60_000,
    // Kept only while the gate is watching it, so once the person is in another hospital the old
    // hospital's answer is gone at once instead of lingering in the cache.
    gcTime: 0,
  });
}

// `gcTime: 0` on both: the results hold the authenticator secret and the recovery codes, which
// must not outlive the screen that shows them.
export const useEnrollMfa = () => useMutation({ mutationFn: enrollMfa, gcTime: 0 });
export const useConfirmMfa = () => useMutation({ mutationFn: confirmMfa, gcTime: 0 });

/** Reloads the session, so the user shows as having an authenticator. */
export function useRefreshSession() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: sessionKey });
}
