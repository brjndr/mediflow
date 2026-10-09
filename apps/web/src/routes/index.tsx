// Route configuration, not a component module, so fast refresh boundaries do not apply.
/* eslint-disable react-refresh/only-export-components */
import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router-dom';
import { AppShell } from '@/app/AppShell';
import { ErrorFallback } from '@/app/ErrorFallback';
import {
  LOGIN_PATH,
  RedirectIfAuthenticated,
  RequireSession,
  RequireTenant,
} from './session-guards';

const HomePage = lazy(() => import('@/app/HomePage').then((m) => ({ default: m.HomePage })));
const LoginPage = lazy(() => import('@/features/auth').then((m) => ({ default: m.LoginPage })));

export const routes: RouteObject[] = [
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
    // F-08 replaces the children with routes generated from the feature registry.
    children: [{ index: true, element: <HomePage /> }],
  },
];
