import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchPolicy, sessionKey, type Session } from '@/app/session';
import { configureApi } from '@/shared/api';
import { useAccessPolicy } from './access-policy-context';

/** How often an open tab asks whether its policy changed. Usually answered with a 304. */
export const POLICY_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A screen can fire several requests that all return 403: refresh once for the burst. */
export const FORBIDDEN_REFRESH_THROTTLE_MS = 10_000;

interface PolicyRefreshOptions {
  intervalMs?: number;
  forbiddenThrottleMs?: number;
}

/**
 * Keeps the access policy current without a reload, so a role or module change made by an admin
 * reaches open tabs. It asks the server on a timer while the tab is visible, when a hidden tab is
 * shown again, and whenever the API answers 403 (the UI offered something the server refused).
 * A changed policy is written into the session cache, which updates every <Can> and guard.
 */
export function usePolicyRefresh({
  intervalMs = POLICY_REFRESH_INTERVAL_MS,
  forbiddenThrottleMs = FORBIDDEN_REFRESH_THROTTLE_MS,
}: PolicyRefreshOptions = {}): void {
  const queryClient = useQueryClient();
  const tenantId = useAccessPolicy()?.tenantId;

  useEffect(() => {
    if (!tenantId) return;
    const abort = new AbortController();
    let etag: string | undefined;
    let inFlight = false;
    let lastRefresh = Date.now();
    let lastForbiddenRefresh = -Infinity;

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      lastRefresh = Date.now();
      try {
        const result = await fetchPolicy(etag, abort.signal);
        if (!result || abort.signal.aborted) return;
        etag = result.etag;
        const { policy } = result;
        queryClient.setQueryData<Session | null>(sessionKey, (session) => {
          // Ignore an answer for another hospital, and keep the same object when nothing changed.
          if (!session || session.activeTenant?.id !== policy.tenantId) return session;
          if (session.policy?.version === policy.version) return session;
          return { ...session, policy };
        });
      } catch {
        // Keep the current policy. The next tick tries again, and 401 and tenant mismatch are
        // already handled by the API client hooks.
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisibilityChange = () => {
      if (!document.hidden && Date.now() - lastRefresh >= intervalMs) void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    configureApi({
      onForbidden: () => {
        const now = Date.now();
        if (now - lastForbiddenRefresh < forbiddenThrottleMs) return;
        lastForbiddenRefresh = now;
        void refresh();
      },
    });

    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      configureApi({ onForbidden: () => {} });
    };
  }, [queryClient, tenantId, intervalMs, forbiddenThrottleMs]);
}
