// Route configuration, not a component module, so fast refresh boundaries do not apply.
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import { PermissionGuard } from '@/access';
import { AppShell } from '@/app/AppShell';
import { DocumentTitle } from '@/app/DocumentTitle';
import { RouteErrorFallback } from '@/app/RouteErrorFallback';
import { NotFoundPage } from '@/app/NotFoundPage';
import { RequireMfa } from '@/features/auth/gate';
import type { Registry } from '@/registry';
import { OpenLinkPage } from '@/tenancy';
import {
  LOGIN_PATH,
  RedirectIfAuthenticated,
  RequireSession,
  RequireTenant,
} from './session-guards';

const HomePage = lazy(() => import('@/app/HomePage').then((m) => ({ default: m.HomePage })));
const LoginPage = lazy(() => import('@/features/auth').then((m) => ({ default: m.LoginPage })));
const AcceptInvitePage = lazy(() =>
  import('@/features/auth').then((m) => ({ default: m.AcceptInvitePage })),
);
const ForgotPasswordPage = lazy(() =>
  import('@/features/auth').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('@/features/auth').then((m) => ({ default: m.ResetPasswordPage })),
);
const ProfilePage = lazy(() => import('@/features/auth').then((m) => ({ default: m.ProfilePage })));
const SecurityPage = lazy(() =>
  import('@/features/auth').then((m) => ({ default: m.SecurityPage })),
);

/** The page with its title in the browser tab (see DocumentTitle). */
const titled = (titleKey: string, page: ReactNode) => (
  <>
    <DocumentTitle titleKey={titleKey} />
    {page}
  </>
);

/** Pages reached from an email or before signing in: no session, no hospital. */
const publicRoutes: RouteObject[] = [
  { path: '/invite', Page: AcceptInvitePage, titleKey: 'account.inviteTitle' },
  { path: '/forgot-password', Page: ForgotPasswordPage, titleKey: 'account.forgotTitle' },
  { path: '/reset-password', Page: ResetPasswordPage, titleKey: 'account.resetTitle' },
].map(({ path, Page, titleKey }) => ({
  path,
  element: titled(
    titleKey,
    <Suspense fallback={null}>
      <Page />
    </Suspense>,
  ),
  errorElement: <RouteErrorFallback />,
}));

/**
 * Feature routes come from the registry. Every registered route is in the tree, and its guard
 * checks the feature flag and permissions each time it renders, so a hospital switch or a policy
 * refresh changes what is reachable without rebuilding the router. A denied route never loads its
 * chunk.
 */
function featureRoutes(registry: Registry): RouteObject[] {
  return registry.routes.map(({ path, requires, featureFlag, titleKey, Component }) => ({
    path,
    element: titled(
      titleKey,
      <PermissionGuard requires={requires} featureFlag={featureFlag}>
        <Component />
      </PermissionGuard>,
    ),
  }));
}

export function createRoutes(registry: Registry): RouteObject[] {
  return [
    {
      path: LOGIN_PATH,
      element: titled(
        'login.title',
        <RedirectIfAuthenticated>
          <Suspense fallback={null}>
            <LoginPage />
          </Suspense>
        </RedirectIfAuthenticated>,
      ),
      errorElement: <RouteErrorFallback />,
    },
    ...publicRoutes,
    {
      // Deep links. Signed in, but not yet in any particular hospital: the server picks it.
      path: '/open/:kind/:id',
      element: titled(
        'link.title',
        <RequireSession>
          <OpenLinkPage />
        </RequireSession>,
      ),
      errorElement: <RouteErrorFallback />,
    },
    {
      path: '/',
      element: (
        <RequireSession>
          <RequireTenant>
            <RequireMfa>
              <AppShell />
            </RequireMfa>
          </RequireTenant>
        </RequireSession>
      ),
      errorElement: <RouteErrorFallback />,
      children: [
        { index: true, element: titled('nav.home', <HomePage />) },
        {
          path: 'profile',
          element: titled(
            'profile.title',
            <Suspense fallback={null}>
              <ProfilePage />
            </Suspense>,
          ),
        },
        {
          path: 'security',
          element: titled(
            'security.title',
            <Suspense fallback={null}>
              <SecurityPage />
            </Suspense>,
          ),
        },
        ...featureRoutes(registry),
        // Inside the shell, so a signed-in user keeps the navigation. Signed-out users are sent
        // to login by the guard above before any route is matched against their address.
        { path: '*', element: titled('notFound.title', <NotFoundPage />) },
      ],
    },
  ];
}
