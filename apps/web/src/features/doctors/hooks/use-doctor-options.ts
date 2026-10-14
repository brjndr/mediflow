import { useQuery } from '@tanstack/react-query';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchDoctors } from '../api';
import { doctorKeys } from './use-doctors';

/** As many as one request may ask for. A hospital with more needs a search, not a select. */
const OPTIONS_LIMIT = 100;

export interface DoctorOption {
  id: string;
  name: string;
  /** The staff member the profile is for: how a screen finds the signed-in doctor's own. */
  userId: string;
}

/**
 * The hospital's practising doctors, to choose one from in another feature's screen (whose
 * appointments to list). Under the doctors list key, so a change to a profile refreshes it.
 *
 * `available` is false for someone who may not read doctors, or at a hospital that has them
 * switched off: nothing is asked for then, and the screen leaves the choice out.
 */
export function useDoctorOptions() {
  const tenantId = useTenant()?.id;
  const allowed = usePermission('doctor:read');
  const switchedOn = useFeatureFlag('doctors');
  const available = allowed && switchedOn;
  const query = useQuery({
    queryKey: doctorKeys.list(tenantId ?? '', {
      active: true,
      limit: OPTIONS_LIMIT,
      // Not the paged list of the doctors screen, which holds pages under a similar key.
      as: 'options',
    }),
    queryFn: ({ signal }) =>
      fetchDoctors({ q: '', departmentId: '', active: true, limit: OPTIONS_LIMIT }, signal),
    enabled: available && tenantId !== undefined,
    staleTime: 5 * 60_000,
    select: (page): DoctorOption[] =>
      page.items.map(({ id, name, userId }) => ({ id, name, userId })),
  });
  return { ...query, available };
}
