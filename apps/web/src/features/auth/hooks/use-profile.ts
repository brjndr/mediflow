import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createTenantKeys } from '@/shared/api';
import { changePassword, listAccountSessions, revokeAccountSession } from '../api';

// The sessions belong to the user, not to a hospital, but the key is still scoped by the active
// hospital like every other, so a hospital switch or a sign-out drops it with the rest.
const accountKeys = createTenantKeys('account');
const sessionsKey = (tenantId: string) => [...accountKeys.all(tenantId), 'sessions'] as const;

export function useChangePassword(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: changePassword,
    // The variables hold both passwords, which must not outlive the form.
    gcTime: 0,
    // The server ends the user's other sessions, so the list is out of date.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey(tenantId) }),
  });
}

export function useAccountSessions(tenantId: string) {
  return useQuery({
    queryKey: sessionsKey(tenantId),
    queryFn: ({ signal }) => listAccountSessions(signal),
    staleTime: 30_000,
  });
}

export function useRevokeSession(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAccountSession,
    onSettled: () => queryClient.invalidateQueries({ queryKey: sessionsKey(tenantId) }),
  });
}
