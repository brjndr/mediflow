import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { AppDispatch } from '../store';
import { dropSessionData, sessionKey, sessionMutationKey } from './session-query';
import type { Session } from './types';

/**
 * Why the last session in this browser ended, so the login page can say so.
 * - `signed_out`: the user chose to, here. Nothing needs saying.
 * - `signed_out_elsewhere`: they signed out in another tab.
 * - `idle`: nobody used the app for the hospital's idle time.
 * - `expired`: the server ended it (its own time limit, or the session was revoked).
 */
export type SessionEndReason = 'signed_out' | 'signed_out_elsewhere' | 'idle' | 'expired';

// Under the session prefix, so it survives everything else being dropped. It holds a word from
// the list above and nothing about the user.
const endReasonKey = sessionMutationKey('end-reason');

export function setSessionEndReason(
  queryClient: QueryClient,
  reason: SessionEndReason | null,
): void {
  queryClient.setQueryData<SessionEndReason | null>(endReasonKey, reason);
}

/** Null while signed in, and for a visitor who has not been signed in here before. */
export function useSessionEndReason(): SessionEndReason | null {
  const { data } = useQuery<SessionEndReason | null>({
    queryKey: endReasonKey,
    // Never fetched: it is only ever set by the functions in this file.
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? null;
}

/**
 * Ends the session in this tab: everything loaded under it is aborted and dropped in the same
 * step that the session disappears, so nothing of this user's can be shown to whoever uses the
 * browser next. Whatever the reason, the result on screen is the login page.
 */
export function endSessionLocally(
  queryClient: QueryClient,
  dispatch: AppDispatch,
  reason: SessionEndReason,
): void {
  dropSessionData(queryClient, dispatch);
  setSessionEndReason(queryClient, reason);
  queryClient.setQueryData<Session | null>(sessionKey, null);
}
