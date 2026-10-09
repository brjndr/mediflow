import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { SystemPage } from '@/shared/ui/system-page';

/** Shown when rendering fails. Never displays the error itself: it may contain patient data. */
export function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <SystemPage
      fullScreen
      alert
      title={t('error.title')}
      description={t('error.description')}
      actions={<Button onClick={() => window.location.reload()}>{t('error.reload')}</Button>}
    />
  );
}
