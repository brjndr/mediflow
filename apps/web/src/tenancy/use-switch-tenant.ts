import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  announceSessionChange,
  dropSessionData,
  sessionKey,
  sessionMutationKey,
  switchTenant,
  type Session,
} from '@/app/session';
import { useAppDispatch } from '@/app/store-hooks';

/**
 * Switches the active hospital. The server rebinds the session; then, in one synchronous step,
 * everything loaded for the previous hospital is aborted and dropped before the new session is
 * exposed, so no screen can render old data under the new tenant. If the server refuses, nothing
 * changes.
 */
export function useSwitchTenant({ returnHome = true }: { returnHome?: boolean } = {}) {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  return useMutation({
    mutationKey: sessionMutationKey('switch-tenant'),
    mutationFn: switchTenant,
    onSuccess: (session) => {
      dropSessionData(queryClient, dispatch);
      queryClient.setQueryData<Session | null>(sessionKey, session);
      announceSessionChange();
      // The current screen may point at a record that belongs to the previous hospital.
      if (returnHome) navigate('/', { replace: true });
    },
  });
}
