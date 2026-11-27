import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { fetchPolicy, sessionKey, type Session } from '@/app/session';
import { invalidateStaffRoles } from '@/features/staff';
import { createTenantKeys, isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createRole,
  deleteRole,
  fetchPermissionCatalog,
  fetchRole,
  fetchRoles,
  renameRole,
  saveRoleGrants,
} from '../api';
import type { RoleGrant, RoleSummary } from '../types';

/** Every key is prefixed with the tenant, so one hospital's roles never show in another. */
export const roleKeys = createTenantKeys('roles');

/** An admin acts on what the list says, and member counts move: keep it fresh. */
const STALE_TIME_MS = 30_000;

/** The hospital's roles, built-in ones first. A hospital has few, so the list is not paged. */
export function useRoles() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: roleKeys.list(tenantId ?? '', {}),
    queryFn: ({ signal }) => fetchRoles(signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/**
 * After any change the list is asked for again, and so is the staff module's list of roles that
 * someone can be invited into: a new custom role shows in the invite form without a reload.
 */
function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void invalidateStaffRoles(queryClient, tenantId);
    return queryClient.invalidateQueries({ queryKey: roleKeys.lists(tenantId) });
  };
}

export interface SaveRole {
  /** The role being renamed. Absent to add one. */
  editing?: RoleSummary;
  name: string;
}

/** Whether a save was refused because the role has changed since it was read. */
export function isVersionConflict(error: unknown): boolean {
  return isApiError(error) && error.serverCode === 'version_conflict';
}

/**
 * Whether the hospital this screen was drawn for is still the active one. A request carries the
 * hospital active when it is sent, so nothing is sent a second time after a switch.
 */
export function useStillThisHospital() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant?.id === tenantId;
}

/**
 * Renames a role. When it has changed since but still has the name the form opened with (its
 * permissions were saved, say), nothing of this change is in dispute: it is sent again from the
 * version the role has now. A name someone else changed is left to the person to decide.
 */
async function rename(editing: RoleSummary, name: string, stillHere: () => boolean) {
  try {
    return await renameRole(editing.id, name, editing.version);
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    const latest = (await fetchRoles()).find((role) => role.id === editing.id);
    if (!latest || latest.name !== editing.name || !stillHere()) throw error;
    return renameRole(editing.id, name, latest.version);
  }
}

/** Adds a custom role, or renames one. */
export function useSaveRole() {
  const refresh = useRefresh();
  const stillHere = useStillThisHospital();
  // A key identifies one new role as typed: sending the same again reuses it.
  const attempt = useRef<{ name: string; key: string }>(undefined);
  return useMutation({
    mutationFn: ({ editing, name }: SaveRole) => {
      if (editing) return rename(editing, name, stillHere);
      if (attempt.current?.name !== name) attempt.current = { name, key: crypto.randomUUID() };
      return createRole(name, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    // Also after a failure: a conflict means the list on screen is out of date.
    onSettled: refresh,
  });
}

export function useDeleteRole() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (role: RoleSummary) => deleteRole(role.id),
    onSettled: refresh,
  });
}

/** What a permission is and the scopes it can be held at: the same for every hospital. */
const CATALOG_STALE_TIME_MS = 10 * 60_000;

export function usePermissionCatalog() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: roleKeys.list(tenantId ?? '', { catalog: true }),
    queryFn: ({ signal }) => fetchPermissionCatalog(signal),
    enabled: tenantId !== undefined,
    staleTime: CATALOG_STALE_TIME_MS,
  });
}

/** One role with its grants. Not refetched in the background: an open matrix works from a snapshot. */
export function useRole(roleId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: roleKeys.detail(tenantId ?? '', roleId),
    queryFn: ({ signal }) => fetchRole(roleId, signal),
    enabled: tenantId !== undefined,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** Reads the role again, for a save that was refused because someone else saved first. */
export function useLatestRole(roleId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id ?? '';
  return () =>
    queryClient.fetchQuery({
      queryKey: roleKeys.detail(tenantId, roleId),
      queryFn: ({ signal }) => fetchRole(roleId, signal),
      staleTime: 0,
    });
}

/** Saves a role's grants. Refreshes the lists, and the caller's own policy when it was theirs. */
export function useSaveGrants(roleId: string) {
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    mutationFn: ({ permissions, version }: { permissions: RoleGrant[]; version: number }) =>
      saveRoleGrants(roleId, permissions, version),
    onSuccess: async (saved) => {
      if (tenantId) queryClient.setQueryData(roleKeys.detail(tenantId, roleId), saved);
      // The caller's own role may be the one changed: their policy is read again now, not at the
      // next tick. When it is unchanged the cache is left as it is.
      const result = await fetchPolicy().catch(() => undefined);
      if (result) {
        queryClient.setQueryData<Session | null>(sessionKey, (session) =>
          session?.activeTenant?.id === result.policy.tenantId &&
          session.policy?.version !== result.policy.version
            ? { ...session, policy: result.policy }
            : session,
        );
      }
    },
    onSettled: refresh,
  });
}
