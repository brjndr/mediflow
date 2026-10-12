import { useQuery } from '@tanstack/react-query';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchServices } from '../api';
import type { ServiceCategory } from '../types';
import { serviceKeys } from './use-services';

/** As many as one request may ask for. A category with more needs a search, not a select. */
const OPTIONS_LIMIT = 100;

export interface ServiceOption {
  id: string;
  code: string;
  name: string;
}

/**
 * The hospital's services of one category that are in use, to choose one from in another
 * feature's form (the bed-day service of a bed category). Under the services list key, so adding
 * or archiving a service refreshes it. Only the id, code and name leave this feature: a price is
 * the price catalog's to show.
 *
 * `available` is false for someone who may not read services, or at a hospital that has them
 * switched off: nothing is asked for then, and the screen says so or leaves the choice out.
 */
export function useServiceOptions(category: ServiceCategory) {
  const tenantId = useTenant()?.id;
  const allowed = usePermission('service:read');
  const switchedOn = useFeatureFlag('services');
  const available = allowed && switchedOn;
  const query = useQuery({
    queryKey: serviceKeys.list(tenantId ?? '', {
      archived: false,
      category,
      limit: OPTIONS_LIMIT,
      // Not the paged list of the services screen, which holds pages under a similar key.
      as: 'options',
    }),
    queryFn: ({ signal }) =>
      fetchServices({ q: '', category, archived: false, limit: OPTIONS_LIMIT }, signal),
    enabled: available && tenantId !== undefined,
    staleTime: 60_000,
    select: (page): ServiceOption[] => page.items.map(({ id, code, name }) => ({ id, code, name })),
  });
  return { ...query, available };
}
