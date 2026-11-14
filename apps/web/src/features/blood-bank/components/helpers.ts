import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { zonedToUtc } from '@/shared/utils/timezone';
import { donorRefusalKey, refusalKey } from './refusal';

export function useFailure(error: unknown) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const key = refusalKey(error);
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/** Splits a date and time typed in one field and reads them on the hospital's clock. */
export function instant(value: string, timezone: string): string {
  const [day = '', time = '00:00'] = value.split('T');
  return zonedToUtc(day, time, timezone);
}

/** The words for a refusal in the donor dialogs. */
export function useDonorFailure(error: unknown) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const key = donorRefusalKey(error);
  return key ? t(key) : tCommon(errorMessageKey(error));
}
