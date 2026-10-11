import type { components } from '@mediflow/contract';
import { api, apiFetchOnce, requireData } from '@/shared/api';

export type InvitePreview = components['schemas']['InvitePreview'];

/** What the invite screen shows before the person accepts. The token travels in the body. */
export async function inspectInvite(token: string, signal?: AbortSignal): Promise<InvitePreview> {
  return requireData(
    await api.POST('/auth/invite/inspect', { body: { token }, signal, fetch: apiFetchOnce }),
  );
}

export async function acceptInvite(input: { token: string; password?: string }): Promise<void> {
  await api.POST('/auth/invite/accept', { body: input, fetch: apiFetchOnce });
}

export async function forgotPassword(email: string): Promise<void> {
  await api.POST('/auth/password/forgot', { body: { email }, fetch: apiFetchOnce });
}

export async function resetPassword(input: { token: string; password: string }): Promise<void> {
  await api.POST('/auth/password/reset', { body: input, fetch: apiFetchOnce });
}

export type MfaEnrollment = components['schemas']['MfaEnrollment'];

/**
 * Starts setting up an authenticator, after the person re-enters their password. Sign-in does not
 * change until a code is confirmed.
 */
export async function enrollMfa(password: string): Promise<MfaEnrollment> {
  return requireData(
    await api.POST('/auth/mfa/enroll', { body: { password }, fetch: apiFetchOnce }),
  );
}

/** Finishes setup with a code from the authenticator. Returns the recovery codes, this once. */
export async function confirmMfa(code: string): Promise<string[]> {
  const result = requireData(
    await api.POST('/auth/mfa/confirm', { body: { code }, fetch: apiFetchOnce }),
  );
  return result.recoveryCodes;
}

/** Whether the active hospital requires the signed-in user to have an authenticator. */
export async function fetchMfaRequirement(signal?: AbortSignal): Promise<boolean> {
  return requireData(await api.GET('/auth/mfa/requirement', { signal })).required;
}

export type AccountSession = components['schemas']['AccountSession'];

/** Changes the signed-in user's own password. The server ends their other sessions. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await api.POST('/auth/password/change', { body: input, fetch: apiFetchOnce });
}

/** The signed-in user's own active sessions, newest first. */
export async function listAccountSessions(signal?: AbortSignal): Promise<AccountSession[]> {
  return requireData(await api.GET('/auth/sessions', { signal })).items;
}

/** Ends one of the user's other sessions: that browser is signed out on its next request. */
export async function revokeAccountSession(sessionId: string): Promise<void> {
  await api.DELETE('/auth/sessions/{sessionId}', {
    params: { path: { sessionId } },
    fetch: apiFetchOnce,
  });
}
