import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  actOnClaim,
  CLAIM_PAGE_SIZE,
  createClaim,
  fetchClaim,
  fetchClaimAging,
  attachClaimFile,
  detachClaimFile,
  fetchAttachableDocuments,
  fetchClaimExport,
  fetchClaimFiles,
  type ClaimExportFormat,
  fetchClaims,
} from '../claims';
import type { ClaimAction, ClaimCreate, ClaimStatus } from '../types';

/** Every key is prefixed with the tenant, so one hospital's claims never show in another. */
export const claimKeys = createTenantKeys('claims');

const STALE_TIME_MS = 15_000;

export function useClaims(status: ClaimStatus | '') {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: claimKeys.list(tenantId ?? '', { status, limit: CLAIM_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchClaims({ status, cursor: pageParam, limit: CLAIM_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantId ? previous : undefined,
  });
}

export function useClaim(claimId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: claimKeys.detail(tenantId ?? '', claimId),
    queryFn: ({ signal }) => fetchClaim(claimId, signal),
    enabled: tenantId !== undefined && claimId !== '',
    staleTime: STALE_TIME_MS,
  });
}

export function useClaimAging() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: claimKeys.list(tenantId ?? '', { kind: 'aging' }),
    queryFn: ({ signal }) => fetchClaimAging(signal),
    enabled: tenantId !== undefined,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({ queryKey: claimKeys.all(tenantId) });
  };
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
export function useCreateClaim(encounterId: string) {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: ClaimCreate) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createClaim(encounterId, body, attempt.current.key);
    },
    onSuccess: () => {
      attempt.current = undefined;
    },
    onSettled: refresh,
  });
}

export function useExportClaim(claimId: string) {
  return useMutation({
    gcTime: 0,
    mutationFn: (format: ClaimExportFormat) => fetchClaimExport(claimId, format),
  });
}

export function useActOnClaim(claimId: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: ClaimAction) => actOnClaim(claimId, body),
    onSettled: refresh,
  });
}

/** The files of a claim packet; `enabled` is false when the caller cannot read documents. */
export function useClaimFiles(claimId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: claimKeys.list(tenantId ?? '', { kind: 'files', claimId }),
    queryFn: ({ signal }) => fetchClaimFiles(claimId, signal),
    enabled: enabled && tenantId !== undefined && claimId !== '',
    staleTime: STALE_TIME_MS,
  });
}

export function useAttachableDocuments(patientId: string, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: claimKeys.list(tenantId ?? '', { kind: 'attachable', patientId }),
    queryFn: ({ signal }) => fetchAttachableDocuments(patientId, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useChangeClaimFiles(claimId: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ documentId, attach }: { documentId: string; attach: boolean }) =>
      attach ? attachClaimFile(claimId, documentId) : detachClaimFile(claimId, documentId),
    onSettled: refresh,
  });
}
