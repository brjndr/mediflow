import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { usePolicyRefresh } from '@/access';
import { useSession } from '@/app/session';
import { HospitalPicker, SuspendedPage, useTenant, useTenantSync } from '@/tenancy';

export const LOGIN_PATH = '/login';

interface LoginRedirectState {
  from: string;
}

/** Only same-app paths are accepted, so router state can never send a user to another site. */
function intendedPath(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('from' in state)) return '/';
  const { from } = state;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/';
  return from.startsWith(LOGIN_PATH) ? '/' : from;
}

/** Sends unauthenticated users to login, remembering where they were going (in memory only). */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session) return children;
  const state: LoginRedirectState = { from: location.pathname + location.search };
  return <Navigate to={LOGIN_PATH} replace state={state} />;
}

/** Keeps signed-in users out of the login page and returns them to where they were going. */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (!session) return children;
  return <Navigate to={intendedPath(location.state)} replace />;
}

/**
 * Everything below needs an active hospital. A user who works at several and has not picked one
 * gets the picker in place of the app, at the same URL, so the address they asked for is kept.
 */
export function RequireTenant({ children }: { children: ReactNode }) {
  useTenantSync();
  usePolicyRefresh();
  const tenant = useTenant();
  if (!tenant) return <HospitalPicker />;
  // No screen of a suspended hospital is reachable, whatever the address.
  if (tenant.status === 'suspended') return <SuspendedPage />;
  return children;
}
