import { Suspense, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { PLATFORM_NAV } from '@/features/platform';
import { cn } from '@/shared/lib/utils';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { SignOutButton } from './SignOutButton';
import { UserIdentity } from './UserIdentity';

function PlatformNav() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('platform.nav.label')}>
      <ul className="flex flex-wrap gap-1 lg:flex-col">
        {PLATFORM_NAV.map(({ key, labelKey, to, icon: Icon, end }) => (
          <li key={key}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex h-9 items-center gap-3 rounded-md px-3 text-sm pointer-coarse:h-11 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isActive && 'bg-accent font-medium',
                )
              }
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{t(labelKey)}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The frame for a platform administrator. Separate from the hospital shell on purpose: no
 * hospital brand or switcher, and a navigation of its own that never lists a hospital's screens,
 * so no screen of patient data is offered from here. On narrow screens the few items sit in a row
 * above the header instead of a drawer.
 */
export function PlatformShell() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // As the hospital shell: after a navigation, focus moves to the new screen.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      >
        {t('app.skipToContent')}
      </a>
      {/* One navigation: a column at the side on a desktop, a row above the header otherwise. */}
      <aside
        aria-label={t('platform.brand')}
        className="flex flex-col gap-2 border-b p-3 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:gap-4 lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r"
      >
        <p className="flex h-8 items-center px-3 text-sm font-semibold">{t('platform.brand')}</p>
        <PlatformNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <UserIdentity to="/platform/security" />
            <SignOutButton />
          </div>
        </header>
        <main ref={main} id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <Suspense fallback={<PageSkeleton label={t('app.loading')} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
