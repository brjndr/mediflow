import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';

/** Frame around every screen. F-10 adds navigation, the tenant switcher and the user menu. */
export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      >
        {t('app.skipToContent')}
      </a>
      <header className="flex h-14 items-center border-b px-4">
        <span className="text-sm font-semibold text-primary">{t('app.name')}</span>
      </header>
      <main id="main" className="flex flex-1 flex-col">
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {t('app.loading')}
            </p>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
