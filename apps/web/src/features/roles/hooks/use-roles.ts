import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { fetchPolicy, sessionKey, type Session } from '@/app/session';
import { invalidateStaffRoles } from '@/features/staff';
import { createTenantKeys } from '@/shared/api';
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

/** Adds a custom role, or renames one. */
export function useSaveRole() {
  const refresh = useRefresh();
  // A key identifies one new role as typed: sending the same again reuses it.
  const attempt = useRef<{ name: string; key: string }>(undefined);
  return useMutation({
    mutationFn: ({ editing, name }: SaveRole) => {
      if (editing) return renameRole(editing.id, name);
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

/**
 * Reads the role again just before a save, so a change someone else made meanwhile is seen.
 * The API takes no version for a role, so the check is on the grants themselves.
 */
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
    mutationFn: (permissions: RoleGrant[]) => saveRoleGrants(roleId, permissions),
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
