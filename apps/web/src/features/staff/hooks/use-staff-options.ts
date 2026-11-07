import { useQuery } from '@tanstack/react-query';
import { usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchStaff } from '../api';
import { staffKeys } from './use-staff';

/** As many as one request may ask for. A hospital with more needs a search, not a select. */
const OPTIONS_LIMIT = 100;

export interface StaffOption {
  id: string;
  name: string;
}

/**
 * The hospital's active staff, to choose one from in another feature's form (a duty roster).
 * `available` is false for someone who may not read staff: nothing is asked for then.
 */
export function useStaffOptions() {
  const tenantId = useTenant()?.id;
  const available = usePermission('staff:read');
  const query = useQuery({
    queryKey: staffKeys.list(tenantId ?? '', { as: 'options', limit: OPTIONS_LIMIT }),
    queryFn: ({ signal }) => fetchStaff({ q: '', status: 'active', limit: OPTIONS_LIMIT }, signal),
    enabled: available && tenantId !== undefined,
    staleTime: 5 * 60_000,
    select: (page): StaffOption[] =>
      page.items.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  });
  return { ...query, available };
}
