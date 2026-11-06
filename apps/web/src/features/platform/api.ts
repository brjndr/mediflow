import { api, requireData } from '@/shared/api';
import {
  auditPageSchema,
  hospitalInvitePageSchema,
  hospitalInviteSchema,
  hospitalPageSchema,
  hospitalSchema,
} from './schemas';
import type {
  AuditPage,
  Hospital,
  HospitalCreate,
  HospitalInvite,
  HospitalInvitePage,
  HospitalLimitsUpdate,
  HospitalPage,
  HospitalStatus,
} from './types';

export async function fetchHospitals(
  {
    cursor,
    limit,
    status,
    q,
  }: { cursor?: string; limit: number; status?: HospitalStatus; q?: string },
  signal?: AbortSignal,
): Promise<HospitalPage> {
  const result = await api.GET('/platform/hospitals', {
    params: { query: { cursor, limit, status, q } },
    signal,
  });
  return hospitalPageSchema.parse(requireData(result));
}

/** The key makes a repeat of the same request (a double click, a retry) create one hospital. */
export async function createHospital(
  body: HospitalCreate,
  idempotencyKey: string,
): Promise<Hospital> {
  const result = await api.POST('/platform/hospitals', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return hospitalSchema.parse(requireData(result));
}

export async function fetchHospital(id: string, signal?: AbortSignal): Promise<Hospital> {
  const result = await api.GET('/platform/hospitals/{id}', { params: { path: { id } }, signal });
  return hospitalSchema.parse(requireData(result));
}

/** Switches modules on or off. Modules not named keep their setting. */
export async function setHospitalFeatures(
  id: string,
  features: { feature: string; enabled: boolean }[],
): Promise<Hospital> {
  const result = await api.PUT('/platform/hospitals/{id}/features', {
    params: { path: { id } },
    body: { features },
  });
  return hospitalSchema.parse(requireData(result));
}

/** Changes the fields named, from the `version` the edit started from. */
export async function updateHospital(id: string, body: HospitalLimitsUpdate): Promise<Hospital> {
  const result = await api.PATCH('/platform/hospitals/{id}', { params: { path: { id } }, body });
  return hospitalSchema.parse(requireData(result));
}

export async function fetchAdminInvites(
  hospitalId: string,
  signal?: AbortSignal,
): Promise<HospitalInvitePage> {
  const result = await api.GET('/platform/hospitals/{id}/admin-invites', {
    params: { path: { id: hospitalId } },
    signal,
  });
  return hospitalInvitePageSchema.parse(requireData(result));
}

/**
 * Invites the first admin. The same address again is the way to send it again: the API withdraws
 * the earlier invite to that address and the new one is emailed.
 */
export async function inviteHospitalAdmin(
  hospitalId: string,
  body: { name: string; email: string },
): Promise<HospitalInvite> {
  const result = await api.POST('/platform/hospitals/{id}/admin-invite', {
    params: { path: { id: hospitalId } },
    body,
  });
  return hospitalInviteSchema.parse(requireData(result));
}

export async function revokeAdminInvite(hospitalId: string, inviteId: string): Promise<void> {
  // A refusal is thrown by the client; a 204 has no body to read.
  await api.POST('/platform/hospitals/{id}/admin-invites/{inviteId}/revoke', {
    params: { path: { id: hospitalId, inviteId } },
  });
}

/** Closes the hospital to its staff, who are signed out at once. Its data is kept. */
export async function suspendHospital(id: string): Promise<Hospital> {
  const result = await api.POST('/platform/hospitals/{id}/suspend', { params: { path: { id } } });
  return hospitalSchema.parse(requireData(result));
}

/** Opens a suspended hospital again, or cancels an offboarding that has not run. */
export async function reactivateHospital(id: string): Promise<Hospital> {
  const result = await api.POST('/platform/hospitals/{id}/reactivate', {
    params: { path: { id } },
  });
  return hospitalSchema.parse(requireData(result));
}

/** Closes the hospital and marks its data for deletion after the days given. Nothing is deleted yet. */
export async function offboardHospital(id: string, deleteAfterDays: number): Promise<Hospital> {
  const result = await api.POST('/platform/hospitals/{id}/offboard', {
    params: { path: { id } },
    body: { deleteAfterDays },
  });
  return hospitalSchema.parse(requireData(result));
}

export async function fetchAudit(
  {
    cursor,
    limit,
    hospitalId,
    actorId,
  }: { cursor?: string; limit: number; hospitalId?: string; actorId?: string },
  signal?: AbortSignal,
): Promise<AuditPage> {
  const result = await api.GET('/platform/audit', {
    params: { query: { cursor, limit, hospitalId, actorId } },
    signal,
  });
  return auditPageSchema.parse(requireData(result));
}
