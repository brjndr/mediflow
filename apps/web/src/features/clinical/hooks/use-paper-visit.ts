import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRefreshDocuments } from '@/features/documents';
import { useTenant } from '@/tenancy';
import {
  closePaperVisit,
  fetchPaperVisit,
  openPaperVisit,
  retireOwnSheet,
  type PaperSubject,
} from '../api';
import type { PaperVisit } from '../types';
import { clinicalKeys, useIdempotencyKey, useStillHere } from './use-clinical';

/** How often the visit is read again while a sheet waits for its malware scan. */
const SCAN_POLL_MS = 5000;

const idOf = (subject: PaperSubject) =>
  'tokenId' in subject ? `token:${subject.tokenId}` : subject.encounterId;

/**
 * A visit kept on paper (#1202): who it is for, what the caller attached, and the changes. Kept
 * only while the dialog is open.
 */
export function usePaperVisit(subject: PaperSubject) {
  const tenantId = useTenant()?.id;
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const refreshDocuments = useRefreshDocuments();
  const openKey = useIdempotencyKey();
  const closeKey = useIdempotencyKey();
  const keyOf = (tenant: string) =>
    [...clinicalKeys.detail(tenant, idOf(subject)), 'paper'] as const;

  const query = useQuery({
    queryKey: keyOf(tenantId ?? ''),
    queryFn: ({ signal }) => fetchPaperVisit(subject, signal),
    enabled: tenantId !== undefined,
    gcTime: 0,
    refetchInterval: (current) =>
      current.state.data?.sheets.some((sheet) => sheet.status === 'scanning')
        ? SCAN_POLL_MS
        : false,
  });

  /** Written only for the session it was asked in. */
  const keep = (visit: PaperVisit) => {
    const tenant = stillHere();
    if (tenant) queryClient.setQueryData(keyOf(tenant), visit);
  };
  /** The visit's screen and lists show what changed. */
  const refresh = () => {
    const tenant = stillHere();
    if (!tenant) return;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: clinicalKeys.all(tenant) }),
      refreshDocuments(),
    ]);
  };

  const open = useMutation({
    gcTime: 0,
    mutationFn: (tokenId: string) => openPaperVisit(tokenId, openKey.keyFor(tokenId)),
    onSuccess: (visit) => {
      openKey.clear();
      keep(visit);
    },
  });
  const close = useMutation({
    gcTime: 0,
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      closePaperVisit(id, version, closeKey.keyFor({ id, version })),
    onSuccess: (visit) => {
      closeKey.clear();
      keep(visit);
    },
    onSettled: () => refresh(),
  });
  const retire = useMutation({
    gcTime: 0,
    mutationFn: (sheet: { encounterId: string; id: string; version: number; reason: string }) =>
      retireOwnSheet(sheet.encounterId, sheet.id, {
        reason: sheet.reason,
        expectedVersion: sheet.version,
      }),
    onSuccess: keep,
    onSettled: () => refresh(),
  });

  return { query, open, close, retire, refresh };
}
