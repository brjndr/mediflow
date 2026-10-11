import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { usePolicyRefresh } from '@/access';
import { useSession, useSessionEndReason } from '@/app/session';
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

/**
 * Sends unauthenticated users to login. A visitor who arrives signed out, or whose session the
 * server ended while they were working, is taken back to the address they were at after signing
 * in (kept in memory only). After a sign-out or an idle timeout the address is not kept: the
 * screen was left on purpose or left unattended, and the next person to sign in may be someone
 * else.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const ended = useSessionEndReason();
  const location = useLocation();
  if (session) return children;
  const state: LoginRedirectState | undefined =
    ended === null || ended === 'expired'
      ? { from: location.pathname + location.search }
      : undefined;
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
