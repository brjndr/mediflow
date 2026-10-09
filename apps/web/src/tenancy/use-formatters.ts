import { createFormatters, type Formatters } from '@/shared/utils/format';
import { useTenant } from './tenant-context';

/**
 * Date, time, number and money formatters for the active hospital. Components call these and
 * never pass a locale, timezone or currency themselves:
 *
 *   const format = useFormatters();
 *   format.dateTime(appointment.startsAt); format.money(invoice.totalMinor);
 */
export function useFormatters(): Formatters {
  const tenant = useTenant();
  return createFormatters(
    tenant
      ? { locale: tenant.locale, timezone: tenant.timezone, currency: tenant.currency }
      : undefined,
  );
}
