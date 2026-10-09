import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
import { SystemPage } from '@/shared/ui/system-page';

/** Shown inside the shell for an address that matches no route. */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <SystemPage
      title={t('notFound.title')}
      description={t('notFound.description')}
      actions={
        <Button asChild variant="outline">
          <Link to="/">{t('nav.backHome')}</Link>
        </Button>
      }
    />
  );
}
