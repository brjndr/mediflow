import { api, requireData } from '@/shared/api';
import {
  inviteSchema,
  sessionsRevokedSchema,
  staffMemberSchema,
  staffPageSchema,
  staffRolesSchema,
} from './schemas';
import type {
  Invite,
  InviteRequest,
  StaffMember,
  StaffPage,
  StaffRole,
  StaffStatus,
} from './types';

export interface StaffFilters {
  /** A name or an email address of a member of staff. Not patient data, so it may be a query. */
  q: string;
  status: StaffStatus;
}

export async function fetchStaff(
  { cursor, limit, q, status }: StaffFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<StaffPage> {
  const result = await api.GET('/staff', {
    params: { query: { cursor, limit, q: q || undefined, status } },
    signal,
  });
  return staffPageSchema.parse(requireData(result));
}

export async function fetchStaffRoles(signal?: AbortSignal): Promise<StaffRole[]> {
  const result = await api.GET('/staff/roles', { signal });
  return staffRolesSchema.parse(requireData(result)).items;
}

export async function deactivateStaff(userId: string): Promise<StaffMember> {
  const result = await api.POST('/staff/{userId}/deactivate', { params: { path: { userId } } });
  return staffMemberSchema.parse(requireData(result));
}

export async function reactivateStaff(userId: string): Promise<StaffMember> {
  const result = await api.POST('/staff/{userId}/reactivate', { params: { path: { userId } } });
  return staffMemberSchema.parse(requireData(result));
}

export async function revokeStaffSessions(userId: string): Promise<number> {
  const result = await api.POST('/staff/{userId}/revoke-sessions', {
    params: { path: { userId } },
  });
  return sessionsRevokedSchema.parse(requireData(result)).revoked;
}

/**
 * Emails an invitation. The key makes a repeat of the same request (a double click, a retry)
 * send one email, not two.
 */
export async function sendInvite(body: InviteRequest, idempotencyKey: string): Promise<Invite> {
  const result = await api.POST('/invites', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return inviteSchema.parse(requireData(result));
}
