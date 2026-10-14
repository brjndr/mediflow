import { useInfiniteQuery } from '@tanstack/react-query';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchAppointments, type AppointmentFilters } from '../api';

/** Every key is prefixed with the tenant, so one hospital's appointments never show in another. */
export const appointmentKeys = createTenantKeys('appointments');

export const APPOINTMENTS_PAGE_SIZE = 25;

/** Live data: the desk books and changes appointments all day. */
const STALE_TIME_MS = 15_000;

/** The appointment list, one server page at a time. Filtering and order are the server's job. */
export function useAppointments(filters: AppointmentFilters, enabled = true) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: appointmentKeys.list(tenantId ?? '', { ...filters, limit: APPOINTMENTS_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchAppointments({ ...filters, cursor: pageParam, limit: APPOINTMENTS_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous) => previous,
  });
}
