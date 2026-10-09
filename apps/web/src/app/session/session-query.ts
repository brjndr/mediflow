import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { resetClientState, type AppDispatch } from '../store';
import { fetchSession } from './api';

const SESSION_SCOPE = 'session';

/**
 * Not tenant-scoped on purpose: the session is what decides the active tenant. Every other key
 * that holds tenant data is prefixed with the tenant id (CLAUDE.md Multi-Tenancy).
 */
export const sessionKey = [SESSION_SCOPE] as const;

/** Session mutations use this prefix so they survive the cache being dropped under them. */
export const sessionMutationKey = (name: string) => [SESSION_SCOPE, name] as const;

export const sessionQueryOptions = queryOptions({
  queryKey: sessionKey,
  queryFn: ({ signal }) => fetchSession(signal),
  // Refreshed explicitly (sign-in, tenant switch, 401), never on a timer or remount.
  staleTime: Infinity,
  gcTime: Infinity,
});

const isSessionKey = (key: readonly unknown[] | undefined) => key?.[0] === SESSION_SCOPE;

/**
 * Called whenever the session or its active tenant changes (tenant switch, stale tab, 401).
 * Aborts in-flight requests and drops every cached query, mutation result and Redux slice, so
 * nothing loaded for the previous user or hospital can be shown again. Only the session stays.
 */
export function dropSessionData(queryClient: QueryClient, dispatch: AppDispatch): void {
  const notSession = {
    predicate: (query: { queryKey: readonly unknown[] }) => !isSessionKey(query.queryKey),
  };
  void queryClient.cancelQueries(notSession);
  queryClient.removeQueries(notSession);
  const mutations = queryClient.getMutationCache();
  for (const mutation of mutations.getAll()) {
    if (!isSessionKey(mutation.options.mutationKey)) mutations.remove(mutation);
  }
  dispatch(resetClientState());
}
