import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { bmiOf, flagOf, type Flag, type RangedMeasure } from '../schemas';
import type { Vitals, VitalRanges } from '../types';

type Ranges = VitalRanges['ranges'];

/** One line of a reading: what was measured, its value with its unit, and a flag when abnormal. */
export interface ReadingLine {
  id: 'pressure' | 'pulse' | 'temperature' | 'spo2' | 'weight' | 'height' | 'bmi';
  text: string;
  flag?: Flag;
}

/**
 * The lines of a reading in the order they are shown, each formatted for the hospital's locale.
 * Blood pressure is one line, flagged by whichever of its two numbers is out of range first.
 * A saved reading carries what was out of range when it was recorded (`flags`, from the server);
 * a value still being typed has none, and is marked against `ranges`, the patient's today.
 */
export function useReadingLines() {
  const { t } = useTranslation('triage');
  const format = useFormatters();
  // One function while the language and the hospital stay: lists memoise on it.
  return useCallback(
    (reading: Partial<Vitals>, ranges: Ranges | undefined): ReadingLine[] => {
      const n = (value: number) => format.number(value, { maximumFractionDigits: 1 });
      const lines: ReadingLine[] = [];
      const add = (id: ReadingLine['id'], text: string, flag?: Flag) =>
        lines.push(flag ? { id, text, flag } : { id, text });
      const { systolic, diastolic, pulse, temperature, spo2, weight, height, flags } = reading;
      const flagFor = (name: RangedMeasure, value: number | undefined) =>
        flags ? flags[name] : flagOf(value, ranges?.[name]);
      if (systolic !== undefined && diastolic !== undefined) {
        add(
          'pressure',
          t('units.pressure', { systolic: n(systolic), diastolic: n(diastolic) }),
          flagFor('systolic', systolic) ?? flagFor('diastolic', diastolic),
        );
      }
      if (pulse !== undefined)
        add('pulse', t('units.pulse', { value: n(pulse) }), flagFor('pulse', pulse));
      if (temperature !== undefined) {
        add(
          'temperature',
          t('units.temperature', { value: n(temperature) }),
          flagFor('temperature', temperature),
        );
      }
      if (spo2 !== undefined)
        add('spo2', t('units.spo2', { value: n(spo2) }), flagFor('spo2', spo2));
      if (weight !== undefined) add('weight', t('units.weight', { value: n(weight) }));
      if (height !== undefined) add('height', t('units.height', { value: n(height) }));
      const bmi = bmiOf(weight, height);
      if (bmi !== undefined) add('bmi', t('units.bmi', { value: n(bmi) }));
      return lines;
    },
    [t, format],
  );
}
