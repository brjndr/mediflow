import { api, isApiError, requireData } from '@/shared/api';
import {
  auditPageSchema,
  hospitalDeletionSchema,
  hospitalExportListSchema,
  hospitalInvitePageSchema,
  hospitalInviteSchema,
  hospitalPageSchema,
  hospitalSchema,
  moduleListSchema,
} from './schemas';
import type {
  AuditPage,
  Hospital,
  HospitalCreate,
  HospitalDeletion,
  HospitalExport,
  HospitalInvite,
  HospitalInvitePage,
  HospitalLimitsUpdate,
  HospitalPage,
  HospitalStatus,
  PlatformModuleList,
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

/** The ids a hospital can be given, from the API. */
export async function fetchModules(signal?: AbortSignal): Promise<PlatformModuleList> {
  const result = await api.GET('/platform/modules', { signal });
  return moduleListSchema.parse(requireData(result));
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

/** The hospital's offboarding exports, newest first: what the deletion checks. */
export async function fetchHospitalExports(
  id: string,
  signal?: AbortSignal,
): Promise<HospitalExport[]> {
  const result = await api.GET('/platform/hospitals/{id}/exports', {
    params: { path: { id } },
    signal,
  });
  return hospitalExportListSchema.parse(requireData(result)).items;
}

/** The latest request to delete the hospital's data, or null when there has been none. */
export async function fetchHospitalDeletion(
  id: string,
  signal?: AbortSignal,
): Promise<HospitalDeletion | null> {
  try {
    const result = await api.GET('/platform/hospitals/{id}/deletion', {
      params: { path: { id } },
      signal,
    });
    return hospitalDeletionSchema.parse(requireData(result));
  } catch (error) {
    if (isApiError(error) && error.serverCode === 'no_deletion') return null;
    throw error;
  }
}

/** Asks for the data to be deleted. Nothing is deleted until a second platform admin approves. */
export async function requestHospitalDeletion(
  id: string,
  waiverReference: string,
): Promise<HospitalDeletion> {
  const result = await api.POST('/platform/hospitals/{id}/deletion', {
    params: { path: { id } },
    body: waiverReference === '' ? {} : { waiverReference },
  });
  return hospitalDeletionSchema.parse(requireData(result));
}

export async function approveHospitalDeletion(id: string): Promise<HospitalDeletion> {
  const result = await api.POST('/platform/hospitals/{id}/deletion/approve', {
    params: { path: { id } },
  });
  return hospitalDeletionSchema.parse(requireData(result));
}

export async function cancelHospitalDeletion(id: string): Promise<HospitalDeletion> {
  const result = await api.POST('/platform/hospitals/{id}/deletion/cancel', {
    params: { path: { id } },
  });
  return hospitalDeletionSchema.parse(requireData(result));
}
