import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch } from '../store-hooks';
import { signOut } from './api';
import { announceSessionChange } from './session-channel';
import { dropSessionData, sessionKey, sessionMutationKey } from './session-query';
import type { Session } from './types';

/**
 * Signs out. Once the server has ended the session, everything loaded under it is aborted and
 * dropped in the same step that the session disappears, so nothing of this user's can be shown
 * to whoever uses the browser next. Other tabs are told to reload their session.
 *
 * If the server cannot be reached nothing changes: the user is still signed in there, and saying
 * otherwise would leave an open session behind a login screen.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  return useMutation({
    mutationKey: sessionMutationKey('sign-out'),
    mutationFn: signOut,
    onSuccess: () => {
      dropSessionData(queryClient, dispatch);
      queryClient.setQueryData<Session | null>(sessionKey, null);
      announceSessionChange();
      // Explicitly to login with no remembered address: the next person to sign in here must
      // not be taken to the screen the previous one was on.
      navigate('/login', { replace: true });
    },
  });
}
