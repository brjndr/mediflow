import { useQuery } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { fetchOpdCapacity } from '../api';
import { appointmentKeys } from './use-appointments';

/** Counts that move as the desk books and doctors call: read again when looked at after this. */
const STALE_TIME_MS = 30_000;

/**
 * How full today's OPD is (#1126), for the landing page. Counts only: nothing about a patient is
 * read, so nothing is audited; it is read when the page opens and when the window is looked at
 * again after a while, never on a timer.
 */
export function useOpdCapacity() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...appointmentKeys.all(tenantId ?? ''), 'capacity'] as const,
    queryFn: ({ signal }) => fetchOpdCapacity(signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}
