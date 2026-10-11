import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  announceSessionChange,
  dropSessionData,
  openLink,
  sessionKey,
  sessionMutationKey,
  type Session,
} from '@/app/session';
import { useAppDispatch } from '@/app/store-hooks';

interface LinkTarget {
  kind: string;
  id: string;
  /** The in-app address of the record, from the feature that owns that kind. */
  path: string;
}

/**
 * Opens a deep link. The server decides which hospital the record belongs to and whether this
 * user works there; the app never works that out itself, and learns nothing when the answer is
 * no. If the server moved the session to another hospital, everything loaded for the previous
 * one is dropped before the new session is exposed, exactly as on a manual switch.
 */
export function useOpenLink() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  return useMutation({
    mutationKey: sessionMutationKey('open-link'),
    mutationFn: ({ kind, id }: LinkTarget) => openLink({ kind, id }),
    onSuccess: (session, { path }) => {
      const before = queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant?.id;
      if (session.activeTenant?.id !== before) {
        dropSessionData(queryClient, dispatch);
        queryClient.setQueryData<Session | null>(sessionKey, session);
        announceSessionChange();
      }
      // The route's own guard still decides whether this user may see the screen.
      navigate(`/${path}`, { replace: true });
    },
  });
}
