import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  announceSessionChange,
  dropSessionData,
  sessionKey,
  sessionMutationKey,
  signIn,
  type Session,
} from '@/app/session';
import { useAppDispatch } from '@/app/store-hooks';
import { isApiError } from '@/shared/api';

/**
 * Signs in. On success the session is put in the cache, and the login route's guard takes the
 * user to where they were going (or to the hospital picker when they work at several). Anything
 * left from an earlier user of this browser is dropped first.
 */
export function useSignIn() {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();

  return useMutation({
    mutationKey: sessionMutationKey('sign-in'),
    mutationFn: signIn,
    onSuccess: (session) => {
      dropSessionData(queryClient, dispatch);
      queryClient.setQueryData<Session | null>(sessionKey, session);
      announceSessionChange();
    },
  });
}

/**
 * The message for a failed sign-in, as a translation key.
 *
 * Every refusal of the email and password gets the same words, whether the account does not
 * exist, the password is wrong, or the account is locked or disabled: the form must not help
 * anyone find out which emails have accounts.
 */
export function signInErrorKey(error: unknown): string {
  if (!isApiError(error)) return 'errors.unknown';
  // Only ever sent after the right password, so it reveals nothing new.
  if (error.serverCode === 'mfa_required' || error.serverCode === 'invalid_mfa_code') {
    return 'login.mfaUnavailable';
  }
  if (error.code === 'unauthorized') return 'login.invalid';
  if (error.code === 'rate_limited') return 'login.rateLimited';
  if (error.code === 'network' || error.code === 'timeout' || error.code === 'server') {
    return error.messageKey;
  }
  return 'errors.unknown';
}
