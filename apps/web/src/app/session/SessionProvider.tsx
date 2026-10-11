import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { configureApi, errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useAppDispatch } from '../store-hooks';
import { IdleTimeout } from './IdleTimeout';
import { onSessionMessage } from './session-channel';
import { SessionContext } from './session-context';
import { endSessionLocally, setSessionEndReason } from './session-end';
import { dropSessionData, sessionKey, sessionQueryOptions } from './session-query';
import type { Session } from './types';

function SessionLoading() {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground"
    >
      {t('session.loading')}
    </p>
  );
}

function SessionError({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4"
    >
      <h1 className="text-2xl font-semibold tracking-tight">{t('session.errorTitle')}</h1>
      <p className="text-muted-foreground">{t(errorMessageKey(error))}</p>
      <Button onClick={onRetry} disabled={retrying}>
        {t('session.retry')}
      </Button>
    </div>
  );
}

/**
 * Loads the session in one request and blocks rendering until it resolves, so nothing below ever
 * renders without knowing who is signed in and which hospital is active.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const session = useQuery(sessionQueryOptions);

  useEffect(() => {
    configureApi({
      // Read from the cache at call time so a tenant switch is picked up by the next request.
      getTenantId: () => queryClient.getQueryData<Session | null>(sessionKey)?.activeTenant?.id,
      // The session ended on the server: drop it and everything loaded under it. A 401 with no
      // session to lose (the first load, a refused sign-in) is not an ending.
      onUnauthorized: () => {
        if (queryClient.getQueryData<Session | null>(sessionKey)) {
          endSessionLocally(queryClient, dispatch, 'expired');
        }
      },
    });
    return () => configureApi({ getTenantId: () => undefined, onUnauthorized: () => {} });
  }, [queryClient, dispatch]);

  // A screen that is still on the page when the session ends can ask for its data once more in
  // the instant before it is removed. This runs after those screens are gone and sweeps again,
  // so nothing loaded under the old session is left in memory behind the login page.
  const signedOut = session.data === null;
  useEffect(() => {
    if (signedOut) dropSessionData(queryClient, dispatch);
  }, [signedOut, queryClient, dispatch]);

  // Signing in or out in one tab applies to every tab of this browser at once.
  useEffect(
    () =>
      onSessionMessage((message) => {
        if (message === 'signed-out') {
          if (queryClient.getQueryData<Session | null>(sessionKey)) {
            endSessionLocally(queryClient, dispatch, 'signed_out_elsewhere');
          }
        } else if (message === 'signed-in') {
          // Possibly as someone else: nothing loaded before may be shown under the new session.
          dropSessionData(queryClient, dispatch);
          setSessionEndReason(queryClient, null);
          void queryClient.invalidateQueries({ queryKey: sessionKey, exact: true });
        }
      }),
    [queryClient, dispatch],
  );

  if (session.isPending) return <SessionLoading />;
  if (session.isError) {
    return (
      <SessionError
        error={session.error}
        onRetry={() => void session.refetch()}
        retrying={session.isFetching}
      />
    );
  }
  return (
    <SessionContext.Provider value={session.data}>
      {session.data && <IdleTimeout minutes={session.data.activeTenant?.auth.idleTimeoutMinutes} />}
      {children}
    </SessionContext.Provider>
  );
}
