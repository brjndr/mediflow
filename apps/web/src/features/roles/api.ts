import { api, requireData } from '@/shared/api';
import { roleDetailSchema, roleListSchema } from './schemas';
import type { RoleDetail, RoleSummary } from './types';

export async function fetchRoles(signal?: AbortSignal): Promise<RoleSummary[]> {
  const result = await api.GET('/roles', { signal });
  return roleListSchema.parse(requireData(result)).items;
}

/**
 * Adds a custom role with no permissions yet; what it may do is set on the permission matrix.
 * The key makes a repeat of the same request add one role.
 */
export async function createRole(name: string, idempotencyKey: string): Promise<RoleDetail> {
  const result = await api.POST('/roles', {
    body: { name, permissions: [] },
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return roleDetailSchema.parse(requireData(result));
}

/** Renames a custom role. Its permissions are left as they are. */
export async function renameRole(roleId: string, name: string): Promise<RoleDetail> {
  const result = await api.PUT('/roles/{roleId}', {
    params: { path: { roleId } },
    body: { name },
  });
  return roleDetailSchema.parse(requireData(result));
}

export async function deleteRole(roleId: string): Promise<void> {
  await api.DELETE('/roles/{roleId}', { params: { path: { roleId } } });
}
