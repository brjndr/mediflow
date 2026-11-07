import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { invalidateStaffRoles } from '@/features/staff';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { createRole, deleteRole, fetchRoles, renameRole } from '../api';
import type { RoleSummary } from '../types';

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
