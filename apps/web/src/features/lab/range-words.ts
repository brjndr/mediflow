import type { TFunction } from 'i18next';
import type { LabResultRange } from './types';

/**
 * A range in words: "12 to 15.5", "below 100" or "at least 5", then its critical limits.
 * `number` is the hospital's number formatter. Keys name their namespace, as this is no component.
 */
export function rangeWords(
  range: LabResultRange | undefined,
  t: TFunction<'lab'>,
  number: (value: number) => string,
): string {
  if (!range) return '';
  const { low, high, criticalLow, criticalHigh } = range;
  const normal =
    low !== undefined && high !== undefined
      ? t('lab:range.between', { low: number(low), high: number(high) })
      : high !== undefined
        ? t('lab:range.upTo', { high: number(high) })
        : low !== undefined
          ? t('lab:range.from', { low: number(low) })
          : '';
  const critical = [
    criticalLow !== undefined ? t('lab:range.criticalLow', { value: number(criticalLow) }) : '',
    criticalHigh !== undefined ? t('lab:range.criticalHigh', { value: number(criticalHigh) }) : '',
  ].filter(Boolean);
  return [normal, ...critical, range.note ?? ''].filter(Boolean).join(t('lab:range.separator'));
}
