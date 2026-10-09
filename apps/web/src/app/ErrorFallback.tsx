import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';

/** Shown when rendering fails. Never displays the error itself: it may contain patient data. */
export function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4"
    >
      <h1 className="text-2xl font-semibold tracking-tight">{t('error.title')}</h1>
      <p className="text-muted-foreground">{t('error.description')}</p>
      <Button onClick={() => window.location.reload()}>{t('error.reload')}</Button>
    </div>
  );
}
