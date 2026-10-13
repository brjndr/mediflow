import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import type { RichTextDocument } from '@/shared/ui/rich-text';
import { useTenant } from '@/tenancy';
import {
  createTemplate,
  fetchTemplate,
  fetchTemplates,
  fetchTemplateVersion,
  redactTemplateVersion,
  saveTemplate,
  setTemplateArchived,
  type TemplateFilters,
} from '../api';
import type { TemplateKind } from '../placeholders';
import type { RedactionReason } from '../types';

/** Every key is prefixed with the tenant: a hospital's templates are its own. */
export const templateKeys = createTenantKeys('templates');

/** One saved version of a template, under the template's own key. */
export const templateVersionKey = (tenantId: string, templateId: string, version: number | null) =>
  [...templateKeys.detail(tenantId, templateId), 'version', version] as const;

export const TEMPLATES_PAGE_SIZE = 25;
/** Templates change rarely. */
const STALE_TIME_MS = 60_000;

export function useTemplates(filters: TemplateFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: templateKeys.list(tenantId ?? '', { ...filters, limit: TEMPLATES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchTemplates({ ...filters, cursor: pageParam, limit: TEMPLATES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useTemplate(templateId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: templateKeys.detail(tenantId ?? '', templateId),
    queryFn: ({ signal }) => fetchTemplate(templateId, signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/**
 * One version of a template, as it was saved. It never changes, so it is never asked twice,
 * unless it is redacted: every change to a template drops what was read of it.
 */
export function useTemplateVersion(templateId: string, version: number | null) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: templateVersionKey(tenantId ?? '', templateId, version),
    queryFn: ({ signal }) => fetchTemplateVersion(templateId, version ?? 0, signal),
    enabled: tenantId !== undefined && version !== null,
    staleTime: Infinity,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    return queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
  };
}

export function useCreateTemplate() {
  const refresh = useRefresh();
  // A key identifies one template as filled in: sending the same again reuses it, an edited
  // form gets a new one.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (template: { kind: TemplateKind; name: string; body: RichTextDocument }) => {
      const serialized = JSON.stringify(template);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createTemplate(template, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

/** Saves a new version of a template, archives and restores it, or redacts an older version. */
export function useSaveTemplate(templateId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (
      change:
        | { save: { name?: string; body?: RichTextDocument; expectedVersion: number } }
        | { archived: boolean }
        | { redact: { version: number; reason: RedactionReason } },
    ) =>
      'save' in change
        ? saveTemplate(templateId, change.save)
        : 'redact' in change
          ? redactTemplateVersion(templateId, change.redact.version, change.redact.reason)
          : setTemplateArchived(templateId, change.archived),
    onSuccess: (saved) => {
      // Nothing is written if the answer arrives after the session ended or moved to another
      // hospital: the cache it would go into is no longer this person's at this hospital.
      const session = queryClient.getQueryData<Session | null>(sessionKey);
      if (!tenantId || session?.activeTenant?.id !== tenantId) return;
      queryClient.setQueryData(templateKeys.detail(tenantId, templateId), saved);
      // What was read of a version that is now redacted is dropped at once, not kept until the
      // refresh below: its text is what was to be removed.
      queryClient.removeQueries({
        queryKey: [...templateKeys.detail(tenantId, templateId), 'version'],
      });
    },
    // Also after a failure: a conflict means what is on screen is out of date.
    onSettled: refresh,
  });
}
