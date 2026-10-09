import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { dropSessionData, onSessionChangeElsewhere, sessionKey } from '@/app/session';
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
    const resync = () => {
      // Already reloading: requests still in flight with the old tenant must not restart it.
      if (queryClient.isFetching({ queryKey: sessionKey }) > 0) return;
      dropSessionData(queryClient, dispatch);
      dispatch(setNotice('tenantChangedElsewhere'));
      navigate('/', { replace: true });
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    };
    configureApi({ onTenantMismatch: resync });
    const unsubscribe = onSessionChangeElsewhere(resync);
    return () => {
      configureApi({ onTenantMismatch: () => {} });
      unsubscribe();
    };
  }, [queryClient, dispatch, navigate]);
}
