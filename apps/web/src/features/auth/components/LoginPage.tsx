import { useTranslation } from 'react-i18next';

/** Generic, unbranded placeholder. A-01 adds the sign-in form. */
export function LoginPage() {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-3 px-4">
      <p className="text-sm font-semibold text-primary">{t('app.name')}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{t('login.title')}</h1>
      <p className="text-muted-foreground">{t('login.unavailable')}</p>
    </main>
  );
}
