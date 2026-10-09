import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { configureApi, errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { resetClientState } from '../store';
import { useAppDispatch } from '../store-hooks';
import { SessionContext } from './session-context';
import { clearCachedData, sessionKey, sessionQueryOptions } from './session-query';
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
      // The session ended on the server: drop it and everything loaded under it.
      onUnauthorized: () => {
        queryClient.setQueryData<Session | null>(sessionKey, null);
        void clearCachedData(queryClient);
        dispatch(resetClientState());
      },
    });
    return () => configureApi({ getTenantId: () => undefined, onUnauthorized: () => {} });
  }, [queryClient, dispatch]);

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
  return <SessionContext.Provider value={session.data}>{children}</SessionContext.Provider>;
}
