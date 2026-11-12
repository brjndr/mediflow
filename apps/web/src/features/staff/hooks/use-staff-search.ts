import { useQuery } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchStaff } from '../api';
import type { StaffOption } from './use-staff-options';
import { staffKeys } from './use-staff';

/** How many matches the box offers; more are found by typing more of the name. */
const SEARCH_LIMIT = 20;

/**
 * Active staff whose name or email matches the words typed, asked of the server so a hospital
 * with any number of staff can pick anyone. Nothing is asked while the box is empty or closed.
 */
export function useStaffSearch(search: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  const q = search.trim();
  return useQuery({
    queryKey: staffKeys.list(tenantId ?? '', { as: 'search', q, limit: SEARCH_LIMIT }),
    queryFn: ({ signal }) => fetchStaff({ q, status: 'active', limit: SEARCH_LIMIT }, signal),
    enabled: enabled && tenantId !== undefined && q !== '',
    staleTime: 60_000,
    select: (page): StaffOption[] => page.items.map(({ id, name }) => ({ id, name })),
    // The last matches stay while more is typed, at the same hospital only.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}
