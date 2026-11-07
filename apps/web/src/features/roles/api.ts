import { api, requireData } from '@/shared/api';
import { permissionCatalogSchema, roleDetailSchema, roleListSchema } from './schemas';
import type { PermissionCatalog, RoleDetail, RoleGrant, RoleSummary } from './types';

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

/** Every permission the API knows, with the module that owns it and the scopes it can be held at. */
export async function fetchPermissionCatalog(signal?: AbortSignal): Promise<PermissionCatalog> {
  const result = await api.GET('/permission-catalog', { signal });
  return permissionCatalogSchema.parse(requireData(result));
}

export async function fetchRole(roleId: string, signal?: AbortSignal): Promise<RoleDetail> {
  const result = await api.GET('/roles/{roleId}', { params: { path: { roleId } }, signal });
  return roleDetailSchema.parse(requireData(result));
}

/** Replaces the whole set of what a role may do. The name is left as it is. */
export async function saveRoleGrants(
  roleId: string,
  permissions: RoleGrant[],
): Promise<RoleDetail> {
  const result = await api.PUT('/roles/{roleId}', {
    params: { path: { roleId } },
    body: { permissions },
  });
  return roleDetailSchema.parse(requireData(result));
}
