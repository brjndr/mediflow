// Route configuration, not a component module, so fast refresh boundaries do not apply.
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router-dom';
import { PermissionGuard } from '@/access';
import { AppShell } from '@/app/AppShell';
import { ErrorFallback } from '@/app/ErrorFallback';
import { NotFoundPage } from '@/app/NotFoundPage';
import type { Registry } from '@/registry';
import {
  LOGIN_PATH,
  RedirectIfAuthenticated,
  RequireSession,
  RequireTenant,
} from './session-guards';

const HomePage = lazy(() => import('@/app/HomePage').then((m) => ({ default: m.HomePage })));
const LoginPage = lazy(() => import('@/features/auth').then((m) => ({ default: m.LoginPage })));

/**
 * Feature routes come from the registry. Every registered route is in the tree, and its guard
 * checks the feature flag and permissions each time it renders, so a hospital switch or a policy
 * refresh changes what is reachable without rebuilding the router. A denied route never loads its
 * chunk.
 */
function featureRoutes(registry: Registry): RouteObject[] {
  return registry.routes.map(({ path, requires, featureFlag, Component }) => ({
    path,
    element: (
      <PermissionGuard requires={requires} featureFlag={featureFlag}>
        <Component />
      </PermissionGuard>
    ),
  }));
}

export function createRoutes(registry: Registry): RouteObject[] {
  return [
    {
      path: LOGIN_PATH,
      element: (
        <RedirectIfAuthenticated>
          <Suspense fallback={null}>
            <LoginPage />
          </Suspense>
        </RedirectIfAuthenticated>
      ),
      errorElement: <ErrorFallback />,
    },
    {
      path: '/',
      element: (
        <RequireSession>
          <RequireTenant>
            <AppShell />
          </RequireTenant>
        </RequireSession>
      ),
      errorElement: <ErrorFallback />,
      children: [
        { index: true, element: <HomePage /> },
        ...featureRoutes(registry),
        // Inside the shell, so a signed-in user keeps the navigation. Signed-out users are sent
        // to login by the guard above before any route is matched against their address.
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}
