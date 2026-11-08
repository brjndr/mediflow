import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import { fetchMergePreview, fetchPatientMerges, mergePatients } from '../api';
import type { PatientRecord } from '../types';
import { patientKeys } from './use-patients';

const mergesKey = (tenantId: string, patientId: string) =>
  [...patientKeys.all(tenantId), 'merges', patientId] as const;

/** The records merged into this patient. Needs `patient:merge`; the caller checks it first. */
export function usePatientMerges(patientId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: mergesKey(tenantId ?? '', patientId),
    queryFn: ({ signal }) => fetchPatientMerges(patientId, signal),
    enabled: tenantId !== undefined && patientId !== '',
  });
}

/** What merging `sourceId` into this record would move. Needs `patient:merge`. */
export function useMergePreview(targetId: string, sourceId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...mergesKey(tenantId ?? '', targetId), 'preview', sourceId],
    queryFn: ({ signal }) => fetchMergePreview(targetId, sourceId, signal),
    enabled: tenantId !== undefined && targetId !== '' && sourceId !== '' && sourceId !== targetId,
    gcTime: 0,
  });
}

/**
 * Merges `source` into `target`, each at the version read. The idempotency key is kept for an
 * identical resubmit (a retry after a dropped answer), and changes when anything in the request
 * does. Afterwards every patient query of the hospital is read again: the list loses the source.
 */
export function useMergePatients(target: PatientRecord) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMutation({
    mutationFn: ({ source, reason }: { source: PatientRecord; reason: string }) => {
      const body = {
        sourcePatientId: source.id,
        reason,
        expectedVersion: target.version,
        expectedSourceVersion: source.version,
      };
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return mergePatients(target.id, body, attempt.current.key);
    },
    onSettled: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: patientKeys.all(tenantId) });
    },
  });
}
