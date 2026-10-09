import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router-dom';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { TenantBrand, TenantSwitcher } from '@/tenancy';
import { AppNav } from './AppNav';
import { NavDrawer } from './NavDrawer';
import { NoticeBanner } from './NoticeBanner';
import { useAppDispatch, useAppSelector } from './store-hooks';
import { setSidebarCollapsed } from './ui-slice';
import { UserIdentity } from './UserIdentity';

/**
 * Frame around every screen: a sidebar generated from the feature registry, a header with the
 * hospital switcher and the signed-in user, and the routed content. On narrow screens the
 * sidebar is replaced by a drawer opened from the header.
 */
export function AppShell() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector((state) => state.ui.sidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // After a navigation, move focus to the new screen so keyboard and screen-reader users are not
  // left on the link they followed. Not on first load, where it would skip the header.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);

  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      >
        {t('app.skipToContent')}
      </a>

      <aside
        className={cn(
          // Stays in view while a long page scrolls.
          'sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 self-start overflow-y-auto border-r p-3 lg:flex',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <div className={cn('flex h-8 items-center px-3', collapsed && 'sr-only')}>
          <TenantBrand />
        </div>
        <div className="flex-1">
          <AppNav collapsed={collapsed} />
        </div>
        <Button
          variant="ghost"
          size={collapsed ? 'icon' : 'sm'}
          className={cn(!collapsed && 'justify-start gap-3 px-3')}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('nav.expand') : undefined}
          onClick={() => dispatch(setSidebarCollapsed(!collapsed))}
        >
          <CollapseIcon aria-hidden />
          {!collapsed && t('nav.collapse')}
        </Button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <Button
            className="lg:hidden"
            size="icon"
            variant="ghost"
            aria-label={t('nav.openMenu')}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <TenantBrand className="lg:hidden" />
          <TenantSwitcher />
          <div className="ml-auto min-w-0">
            <UserIdentity />
          </div>
        </header>
        <NoticeBanner />
        <main ref={main} id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <Suspense fallback={<PageSkeleton label={t('app.loading')} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
