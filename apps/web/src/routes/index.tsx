// Route configuration, not a component module, so fast refresh boundaries do not apply.
/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import { AppShell } from '@/app/AppShell';
import { ErrorFallback } from '@/app/ErrorFallback';

const HomePage = lazy(() => import('@/app/HomePage').then((m) => ({ default: m.HomePage })));

// F-08 replaces the children with routes generated from the feature registry.
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <ErrorFallback />,
    children: [{ index: true, element: <HomePage /> }],
  },
];
