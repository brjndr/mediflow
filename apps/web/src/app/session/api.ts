import type { components } from '@mediflow/contract';
import { api, isApiError, requireData } from '@/shared/api';
import type { AccessPolicy, Permission, PermissionGrant } from '@/shared/types';
import type { Session } from './types';

type SessionDto = components['schemas']['Session'];
type AccessPolicyDto = components['schemas']['AccessPolicy'];

function isPermission(value: string): value is Permission {
  return /^[^:\s]+:[^:\s]+$/.test(value);
}

// Malformed grants are dropped, never guessed at: a missing permission only ever denies access.
function toPolicy(dto: AccessPolicyDto): AccessPolicy {
  const permissions: PermissionGrant[] = [];
  for (const grant of dto.permissions) {
    if (isPermission(grant.permission)) {
      permissions.push({ permission: grant.permission, scope: grant.scope });
    }
  }
  return { ...dto, permissions };
}

function toSession(dto: SessionDto): Session {
  return { ...dto, policy: dto.policy ? toPolicy(dto.policy) : null };
}

/** Resolves to null when nobody is signed in (401), so that is a state and not an error. */
export async function fetchSession(signal?: AbortSignal): Promise<Session | null> {
  try {
    return toSession(requireData(await api.GET('/session', { signal })));
  } catch (error) {
    if (isApiError(error) && error.code === 'unauthorized') return null;
    throw error;
  }
}

/** Rebinds the server-side session to another of the user's hospitals. Affects every tab. */
export async function switchTenant(tenantId: string): Promise<Session> {
  return toSession(requireData(await api.POST('/session/switch-tenant', { body: { tenantId } })));
}
