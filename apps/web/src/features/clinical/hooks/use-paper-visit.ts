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

  /**
   * Shows the visit a change answered with, in place of reading it again: every read is audited
   * (#1213). Written only for the session it was asked in.
   */
  const keep = async (visit: PaperVisit) => {
    const before = stillHere();
    if (!before) return;
    // A read already on its way (the scan poll) must not put the older visit back.
    await queryClient.cancelQueries({ queryKey: keyOf(before) });
    const tenant = stillHere();
    if (!tenant) return;
    queryClient.setQueryData<PaperVisit>(keyOf(tenant), (shown) => {
      // A dialog already gone took its entry with it: the patient is not put back in the cache.
      if (!shown) return undefined;
      // A change answers with the visit's own token, which a visit opened from an appointment
      // does not have: the token asked about stays on screen.
      return 'tokenId' in subject && shown.tokenNumber !== undefined
        ? { ...visit, tokenNumber: shown.tokenNumber }
        : visit;
    });
  };
  /**
   * The visit's screen and lists show what changed. `kept` leaves the paper visit as it is, after
   * an answer that already held it.
   */
  const refresh = ({ kept = false } = {}) => {
    const tenant = stillHere();
    if (!tenant) return;
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: clinicalKeys.all(tenant),
        predicate: (each) => !kept || each.queryKey.at(-1) !== 'paper',
      }),
      refreshDocuments(),
    ]);
  };

  const open = useMutation({
    gcTime: 0,
    mutationFn: (tokenId: string) => openPaperVisit(tokenId, openKey.keyFor(tokenId)),
    onSuccess: (visit) => {
      openKey.clear();
      return keep(visit);
    },
  });
  const close = useMutation({
    gcTime: 0,
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      closePaperVisit(id, version, closeKey.keyFor({ id, version })),
    onSuccess: (visit) => {
      closeKey.clear();
      return keep(visit);
    },
    // A refusal holds no visit: what is shown may be out of date, so it is read again.
    onSettled: (visit) => refresh({ kept: visit !== undefined }),
  });
  const retire = useMutation({
    gcTime: 0,
    mutationFn: (sheet: { encounterId: string; id: string; version: number; reason: string }) =>
      retireOwnSheet(sheet.encounterId, sheet.id, {
        reason: sheet.reason,
        expectedVersion: sheet.version,
      }),
    onSuccess: keep,
    onSettled: (visit) => refresh({ kept: visit !== undefined }),
  });

  return { query, open, close, retire, refresh };
}
