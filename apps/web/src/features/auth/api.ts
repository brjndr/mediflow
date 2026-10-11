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
