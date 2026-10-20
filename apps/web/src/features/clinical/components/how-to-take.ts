import type { TFunction } from 'i18next';
import type { Order } from '../types';

/** How a medication line is taken, as words: dose, route, frequency, days and quantity. */
export function howToTake(line: Order, t: TFunction<'clinical'>): string {
  return [
    line.dose,
    line.route ? t(`prescriptions.routes.${line.route}`) : undefined,
    line.frequency,
    line.durationDays === undefined
      ? undefined
      : t('prescriptions.days', { count: line.durationDays }),
    line.quantity === undefined ? undefined : t('prescriptions.quantity', { count: line.quantity }),
  ]
    .filter(Boolean)
    .join(' · ');
}
