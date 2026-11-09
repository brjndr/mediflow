import { useQuery } from '@tanstack/react-query';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchServices } from '../api';
import type { ServiceCategory } from '../types';
import { serviceKeys } from './use-services';

/** As many as one request may ask for. */
const PRICES_LIMIT = 100;

/**
 * The price in force today (standard list, minor units) of the services of one category, by
 * service id, to show beside a choice in another feature (the bed-day price when picking a bed).
 * A service with no price is left out. `available` is false without `service:read` or with the
 * module off: nothing is asked for then and the caller shows no price.
 */
export function useServicePrices(category: ServiceCategory) {
  const tenantId = useTenant()?.id;
  const allowed = usePermission('service:read');
  const switchedOn = useFeatureFlag('services');
  const available = allowed && switchedOn;
  const query = useQuery({
    queryKey: serviceKeys.list(tenantId ?? '', {
      archived: false,
      category,
      limit: PRICES_LIMIT,
      as: 'prices',
    }),
    queryFn: ({ signal }) =>
      fetchServices({ q: '', category, archived: false, limit: PRICES_LIMIT }, signal),
    enabled: available && tenantId !== undefined,
    staleTime: 60_000,
    select: (page): Map<string, number> =>
      new Map(
        page.items.flatMap((service) =>
          service.currentPrice ? [[service.id, service.currentPrice.amountMinor] as const] : [],
        ),
      ),
  });
  return { ...query, available };
}
