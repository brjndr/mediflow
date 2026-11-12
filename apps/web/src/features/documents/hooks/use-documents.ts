import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  fetchDocuments,
  fetchDownloadUrl,
  requestUpload,
  retireDocument,
  sendFile,
  type DocumentFilters,
} from '../api';
import { DOCUMENT_PAGE_SIZE, SCAN_POLL_MS } from '../schemas';
import type { PatientDocument, PatientDocumentCreate } from '../types';

/** Every key is prefixed with the tenant, so one hospital's documents never show in another. */
export const documentKeys = createTenantKeys('documents');

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  };
}

/** The patient's documents, newest first, a page at a time. */
export function usePatientDocuments(patientId: string, filters: DocumentFilters) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: documentKeys.list(tenantId ?? '', {
      patientId,
      ...filters,
      limit: DOCUMENT_PAGE_SIZE,
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchDocuments(
        { patientId, ...filters, cursor: pageParam, limit: DOCUMENT_PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // While a file waits for its scan the list is read again, so the uploader sees the outcome.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((one) => one.status === 'pending' || one.status === 'scanning'),
      )
        ? SCAN_POLL_MS
        : false,
    enabled: tenantId !== undefined && patientId !== '',
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId) });
  };
}

/**
 * Attaches a file in the two steps the API has: ask (one request, with a key kept for an
 * identical resubmit), then send the bytes to the signed address. The list is read again either
 * way, since the row exists once asked for.
 */
export function useUploadDocument(patientId: string) {
  const refresh = useRefresh();
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: async ({ file, ...body }: PatientDocumentCreate & { file: File }) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      const asked = await requestUpload(patientId, body, attempt.current.key);
      await sendFile(asked.uploadUrl, file);
      attempt.current = undefined;
      return asked.document;
    },
    onSettled: () => refresh(),
  });
}

export function useRetireDocument() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ document, reason }: { document: PatientDocument; reason: string }) =>
      retireDocument(document.id, { reason, expectedVersion: document.version }),
    onSettled: () => refresh(),
  });
}

/** A signed link for one document; the person opens it. Audited by the API as an export. */
export function useDocumentLink() {
  return useMutation({ mutationFn: (documentId: string) => fetchDownloadUrl(documentId) });
}
