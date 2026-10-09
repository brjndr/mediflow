import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { dropSessionData, onSessionChangeElsewhere, sessionKey, type Session } from '@/app/session';
import { useAppDispatch } from '@/app/store-hooks';
import { setNotice } from '@/app/ui-slice';
import { configureApi } from '@/shared/api';

/**
 * Keeps this tab in step when the active hospital changes in another tab. Two signals trigger it:
 * a broadcast from the tab that switched, and the API rejecting a request whose tenant header is
 * stale (409 tenant_mismatch). Either way this tab drops what it had loaded, reloads the session
 * and tells the user.
 */
export function useTenantSync(): void {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    const activeTenant = () =>
      queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant ?? undefined;
    const reloading = () => queryClient.isFetching({ queryKey: sessionKey }) > 0;

    const resync = () => {
      // Already reloading: requests still in flight with the old tenant must not restart it.
      if (reloading()) return;
      dropSessionData(queryClient, dispatch);
      dispatch(setNotice('tenantChangedElsewhere'));
      navigate('/', { replace: true });
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    };
    // Several requests can be rejected for the same switch, and some of those rejections arrive
    // after this tab has already resynced. A rejection for a tenant this tab no longer uses is
    // old news: acting on it would throw away what was just loaded for the right hospital.
    const onMismatch = (sentTenantId: string | undefined) => {
      if (sentTenantId !== activeTenant()?.id) return;
      resync();
    };
    // The hospital was suspended while this tab was open: reload the session, whose tenant status
    // then replaces the app with the suspended page. Once that is known, later reports of the
    // same suspension change nothing.
    const onSuspended = () => {
      if (reloading() || activeTenant()?.status === 'suspended') return;
      dropSessionData(queryClient, dispatch);
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    };
    configureApi({ onTenantMismatch: onMismatch, onTenantSuspended: onSuspended });
    const unsubscribe = onSessionChangeElsewhere(resync);
    return () => {
      configureApi({ onTenantMismatch: () => {}, onTenantSuspended: () => {} });
      unsubscribe();
    };
  }, [queryClient, dispatch, navigate]);
}
