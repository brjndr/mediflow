import { useMutation, useQuery } from '@tanstack/react-query';
import { isApiError } from '@/shared/api';
import { acceptInvite, forgotPassword, inspectInvite, resetPassword } from '../api';

/**
 * Not tenant-scoped: nobody is signed in. The key never holds the token (a secret): the page
 * keeps one token for its whole life, and the entry is dropped when the page goes (`gcTime: 0`).
 */
const accountKeys = { invitePreview: () => ['auth', 'invite-preview'] as const };

export function useInvitePreview(token: string | null) {
  return useQuery({
    queryKey: accountKeys.invitePreview(),
    queryFn: ({ signal }) => inspectInvite(token ?? '', signal),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}

export const useAcceptInvite = () => useMutation({ mutationFn: acceptInvite });
export const useForgotPassword = () => useMutation({ mutationFn: forgotPassword });
export const useResetPassword = () => useMutation({ mutationFn: resetPassword });

/** The link is spent, expired or wrong. One answer for all three, as the server gives. */
export function isInvalidLink(error: unknown): boolean {
  return isApiError(error) && error.serverCode === 'invalid_token';
}

/** The message for a failed set-password call, as a translation key. */
export function passwordErrorKey(error: unknown): string {
  if (!isApiError(error)) return 'errors.unknown';
  switch (error.serverCode) {
    case 'password_too_short':
      return 'account.passwordTooShort';
    case 'password_too_long':
      return 'validation.too_big';
    case 'password_too_common':
      return 'account.passwordTooCommon';
    default:
      return error.messageKey;
  }
}
