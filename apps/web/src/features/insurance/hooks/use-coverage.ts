import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  cancelPreAuth,
  createPolicy,
  createPreAuth,
  decidePreAuth,
  endPolicy,
  fetchEncounterPreAuths,
  fetchPatientPreAuths,
  fetchPolicies,
} from '../coverage-api';
import type { PatientPolicyCreate, PreAuthCreate, PreAuthDecision } from '../types';

/** Every key is prefixed with the tenant, so one hospital's policies never show in another. */
export const coverageKeys = createTenantKeys('coverage');

const STALE_TIME_MS = 15_000;

export function usePatientPolicies(patientId: string, enabled = true) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: coverageKeys.list(tenantId ?? '', { kind: 'policies', patientId }),
    queryFn: ({ signal }) => fetchPolicies(patientId, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function usePatientPreAuths(patientId: string, enabled = true) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: coverageKeys.list(tenantId ?? '', { kind: 'preauths', patientId }),
    queryFn: ({ signal }) => fetchPatientPreAuths(patientId, signal),
    enabled: enabled && tenantId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

export function useEncounterPreAuths(encounterId: string, enabled = true) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: coverageKeys.detail(tenantId ?? '', `encounter:${encounterId}`),
    queryFn: ({ signal }) => fetchEncounterPreAuths(encounterId, signal),
    enabled: enabled && tenantId !== undefined && encounterId !== '',
    staleTime: STALE_TIME_MS,
    // The bill moves while the desk works: read again when the window comes back.
    refetchOnWindowFocus: true,
  });
}

/** One key for one identical body: a second tap after a slow answer is the same request. */
function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
    keyFor: (body: unknown) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return attempt.current.key;
    },
    done: () => {
      attempt.current = undefined;
    },
  };
}

function useRefresh() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({ queryKey: coverageKeys.all(tenantId) });
  };
}

export function useCreatePolicy(patientId: string) {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PatientPolicyCreate) => createPolicy(patientId, body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useEndPolicy() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ policyId, version }: { policyId: string; version: number }) =>
      endPolicy(policyId, version),
    onSettled: refresh,
  });
}

export function useCreatePreAuth(patientId: string) {
  const attempt = useAttempt();
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PreAuthCreate) => createPreAuth(patientId, body, attempt.keyFor(body)),
    onSuccess: () => attempt.done(),
    onSettled: refresh,
  });
}

export function useDecidePreAuth(preAuthId: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PreAuthDecision) => decidePreAuth(preAuthId, body),
    onSettled: refresh,
  });
}

export function useCancelPreAuth() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ preAuthId, version }: { preAuthId: string; version: number }) =>
      cancelPreAuth(preAuthId, version),
    onSettled: refresh,
  });
}
