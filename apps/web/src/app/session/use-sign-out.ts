import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch } from '../store-hooks';
import { signOut } from './api';
import { announceSignedOut } from './session-channel';
import { endSessionLocally } from './session-end';
import { sessionMutationKey } from './session-query';

/**
 * Signs out. Once the server has ended the session, everything loaded under it is aborted and
 * dropped in the same step that the session disappears, so nothing of this user's can be shown
 * to whoever uses the browser next. Other tabs are told to reload their session.
 *
 * If the server cannot be reached nothing changes: the user is still signed in there, and saying
 * otherwise would leave an open session behind a login screen.
 *
 * `stayOnPage` is for a public page that must keep its address (an emailed link): the session
 * ends the same way, but nobody is sent to login.
 */
export function useSignOut({ stayOnPage = false }: { stayOnPage?: boolean } = {}) {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  return useMutation({
    mutationKey: sessionMutationKey('sign-out'),
    mutationFn: signOut,
    onSuccess: () => {
      endSessionLocally(queryClient, dispatch, 'signed_out');
      announceSignedOut();
      // Explicitly to login with no remembered address: the next person to sign in here must
      // not be taken to the screen the previous one was on.
      if (!stayOnPage) navigate('/login', { replace: true });
    },
  });
}
