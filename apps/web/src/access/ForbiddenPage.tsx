import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/shared/ui/button';
import { SystemPage } from '@/shared/ui/system-page';

/** Shown in place of a screen the user may not open, or a module that is off for the hospital. */
export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <SystemPage
      title={t('access.forbiddenTitle')}
      description={t('access.forbiddenDescription')}
      actions={
        <Button asChild variant="outline">
          <Link to="/">{t('nav.backHome')}</Link>
        </Button>
      }
    />
  );
}
