import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTenant } from '@/tenancy/tenant-context';

/**
 * The browser tab's title for the page shown: the page, the hospital when there is one, the app
 * ("Patients · Sample Hospital · Mediflow"). A screen reader says it after a navigation, and it
 * tells several open tabs apart. Static words from a key only: a title stays in the browser's
 * history, so it never holds a patient's name, an MRN or any record's own text.
 */
export function DocumentTitle({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  const tenant = useTenant();
  const title = [t(titleKey), tenant?.name, t('app.name')].filter(Boolean).join(' · ');
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
