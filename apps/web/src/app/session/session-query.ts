import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { fetchSession } from './api';

const SESSION_SCOPE = 'session';

/**
 * Not tenant-scoped on purpose: the session is what decides the active tenant. Every other key
 * that holds tenant data is prefixed with the tenant id (CLAUDE.md Multi-Tenancy).
 */
export const sessionKey = [SESSION_SCOPE] as const;

export const sessionQueryOptions = queryOptions({
  queryKey: sessionKey,
  queryFn: ({ signal }) => fetchSession(signal),
  // Refreshed explicitly (sign-in, tenant switch, 401), never on a timer or remount.
  staleTime: Infinity,
  gcTime: Infinity,
});

/** Cancels and drops everything except the session itself, so no tenant data outlives it. */
export async function clearCachedData(queryClient: QueryClient): Promise<void> {
  const notSession = {
    predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== SESSION_SCOPE,
  };
  await queryClient.cancelQueries(notSession);
  queryClient.removeQueries(notSession);
  queryClient.getMutationCache().clear();
}
