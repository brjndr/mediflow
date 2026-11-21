import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchExport,
  fetchExportLink,
  requestExport,
  searchAudit,
  type AuditFilters,
} from '../api';
import { WORKING } from '../schemas';

/** Every key is prefixed with the tenant, so one hospital's log never shows in another. */
export const auditKeys = createTenantKeys('audit_log');

export const PAGE_SIZE = 50;

/**
 * The entries for the filters applied, a page at a time. Nothing is kept once the screen is
 * left: the log names who touched which record.
 */
export function useAuditSearch(filters: AuditFilters | null) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: auditKeys.list(tenantId ?? '', { ...filters }),
    queryFn: ({ pageParam, signal }) =>
      searchAudit(filters as AuditFilters, { cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined && filters !== null,
    gcTime: 0,
  });
}

/** An export, followed while its job works: 1, 2, 4, 8 seconds, then every 15. */
export function useExportRun(runId: string | null) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: auditKeys.detail(tenantId ?? '', runId ?? ''),
    queryFn: ({ signal }) => fetchExport(runId ?? '', signal),
    enabled: tenantId !== undefined && runId !== null,
    gcTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined || !WORKING.includes(status)) return false;
      return Math.min(1_000 * 2 ** Math.max(query.state.dataUpdateCount - 1, 0), 15_000);
    },
    refetchIntervalInBackground: false,
  });
}

/** One key for an identical resubmit (a double click), a new one for other days. */
export function useRequestExport() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const keys = useMemo(
    () => ({
      keyFor(body: unknown) {
        const serialized = JSON.stringify(body);
        if (attempt.current?.body !== serialized) {
          attempt.current = { body: serialized, key: crypto.randomUUID() };
        }
        return attempt.current.key;
      },
    }),
    [],
  );
  return useMutation({
    gcTime: 0,
    mutationFn: (body: AuditFilters) => requestExport(body, keys.keyFor(body)),
  });
}

export function useExportLink() {
  return useMutation({ gcTime: 0, mutationFn: (runId: string) => fetchExportLink(runId) });
}
