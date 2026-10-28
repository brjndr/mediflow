import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createIndent,
  fetchIndent,
  fetchIndents,
  fetchPlaces,
  issueIndent,
  stepIndent,
  type IndentStep,
} from '../api';
import type { StockIndent, StockIndentCreate, StockIndentStatus, StockIssueCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's indents never show in another. */
export const indentKeys = createTenantKeys('indents');

export const PAGE_SIZE = 25;
/** The places in use fill a form's list from one page. */
export const PLACES_IN_A_LIST = 100;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return useCallback(() => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  }, [queryClient, tenantId, userId]);
}

/**
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMemo(
    () => ({
      keyFor(body: unknown) {
        const serialized = JSON.stringify(body);
        if (attempt.current?.body !== serialized) {
          attempt.current = { body: serialized, key: crypto.randomUUID() };
        }
        return attempt.current.key;
      },
      clear() {
        attempt.current = undefined;
      },
    }),
    [],
  );
}

/** Whatever the answer, every indent is read again. */
function useRefresh() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: indentKeys.all(tenantId) });
  };
}

/** The places in use, by name (the first hundred), for the form and the list's filter. */
export function useIndentPlaces() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: indentKeys.list(tenantId ?? '', { name: 'places', limit: PLACES_IN_A_LIST }),
    queryFn: ({ signal }) => fetchPlaces({ limit: PLACES_IN_A_LIST }, signal),
    enabled: tenantId !== undefined,
  });
}

export function useIndents(status: StockIndentStatus | '', locationId: string) {
  const tenantId = useTenant()?.id;
  const filters = { status, locationId, limit: PAGE_SIZE };
  return useInfiniteQuery({
    queryKey: indentKeys.list(tenantId ?? '', { name: 'indents', ...filters }),
    queryFn: ({ pageParam, signal }) => fetchIndents({ ...filters, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

export function useIndent(indentId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: indentKeys.detail(tenantId ?? '', indentId),
    queryFn: ({ signal }) => fetchIndent(indentId, signal),
    enabled: tenantId !== undefined && indentId !== '',
  });
}

export function useCreateIndent() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: StockIndentCreate) => createIndent(body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Approves, rejects, withdraws or closes an indent at the version it was read at. */
export function useStepIndent() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ indent, change }: { indent: StockIndent; change: IndentStep }) =>
      stepIndent(
        indent.id,
        indent.version,
        change,
        keys.keyFor({ id: indent.id, version: indent.version, ...change }),
      ),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useIssueIndent(indentId: string) {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: StockIssueCreate) =>
      issueIndent(indentId, body, keys.keyFor({ indentId, ...body })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
