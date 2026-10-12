import { useQuery } from '@tanstack/react-query';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchDepartments } from '../api';
import { departmentKeys } from './use-departments';

/** As many as one request may ask for. A hospital with more needs a search, not a select. */
const OPTIONS_LIMIT = 100;

export interface DepartmentOption {
  id: string;
  name: string;
}

/**
 * The hospital's active departments, to choose one from in another feature's form (a doctor's
 * department). Under the departments list key, so adding or archiving a department refreshes it.
 *
 * `available` is false for someone who may not read departments, or at a hospital that has them
 * switched off: nothing is asked for then, and the screen says so or leaves the choice out.
 */
export function useDepartmentOptions() {
  const tenantId = useTenant()?.id;
  const allowed = usePermission('department:read');
  const switchedOn = useFeatureFlag('departments');
  const available = allowed && switchedOn;
  const query = useQuery({
    queryKey: departmentKeys.list(tenantId ?? '', {
      archived: false,
      limit: OPTIONS_LIMIT,
      // Not the paged list of the departments screen, which holds pages under a similar key.
      as: 'options',
    }),
    queryFn: ({ signal }) => fetchDepartments({ limit: OPTIONS_LIMIT, archived: false }, signal),
    enabled: available && tenantId !== undefined,
    staleTime: 5 * 60_000,
    select: (page): DepartmentOption[] => page.items.map(({ id, name }) => ({ id, name })),
  });
  return { ...query, available };
}
