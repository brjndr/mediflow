import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  archiveDepartment,
  createDepartment,
  fetchDepartments,
  restoreDepartment,
  updateDepartment,
} from '../api';
import type { Department, DepartmentCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's departments never show in another. */
export const departmentKeys = createTenantKeys('departments');

export const DEPARTMENTS_PAGE_SIZE = 25;

/** Reference data: it changes rarely, so a visit within a few minutes does not refetch. */
const STALE_TIME_MS = 5 * 60_000;

/** The departments, one server page at a time: the active ones, or the archived ones. */
export function useDepartments({ archived }: { archived: boolean }) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: departmentKeys.list(tenantId ?? '', { archived, limit: DEPARTMENTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchDepartments({ cursor: pageParam, limit: DEPARTMENTS_PAGE_SIZE, archived }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** After any change both lists (active and archived) are asked for again. */
function useRefreshLists() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId)
      return queryClient.invalidateQueries({ queryKey: departmentKeys.lists(tenantId) });
  };
}

export interface SaveDepartment {
  /** The department being changed. Absent to add one. */
  editing?: Department;
  values: DepartmentCreate;
}

/** Adds a department, or changes one from the version that was on screen. */
export function useSaveDepartment() {
  const refresh = useRefreshLists();
  return useMutation({
    mutationFn: ({ editing, values }: SaveDepartment) =>
      editing
        ? updateDepartment(editing.id, { ...values, expectedVersion: editing.version })
        : createDepartment(values),
    // Also after a failure: a conflict means the list on screen is out of date.
    onSettled: refresh,
  });
}

export function useArchiveDepartment() {
  const refresh = useRefreshLists();
  return useMutation({
    mutationFn: ({ department, archived }: { department: Department; archived: boolean }) =>
      archived ? archiveDepartment(department.id) : restoreDepartment(department.id),
    onSettled: refresh,
  });
}
