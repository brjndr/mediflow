import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import { fetchDischargePlan, putDischargeAdvice, putDischargeClearance } from '../api';
import type { ClearanceKind } from '../types';
import { admissionKeys } from './use-admissions';

const planKey = (tenantId: string, admissionId: string) =>
  [...admissionKeys.all(tenantId), 'discharge-plan', admissionId] as const;

/**
 * The plan of a stay, for someone who may read admissions. The endpoint is planned, so a hospital
 * on the real API gets an error: then there is no plan and nothing here gates the discharge.
 */
export function useDischargePlan(admissionId: string) {
  const tenantId = useTenant()?.id;
  const canRead = usePermission('admission:read');
  const switchedOn = useFeatureFlag('admissions');
  const enabled = tenantId !== undefined && canRead && switchedOn;
  const found = useQuery({
    queryKey: planKey(tenantId ?? '', admissionId),
    queryFn: ({ signal }) => fetchDischargePlan(admissionId, signal),
    enabled,
    staleTime: 0,
    retry: false,
  });
  return { pending: enabled && found.isPending, plan: found.data };
}

function useAttempt() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
}

function useRefreshPlan(admissionId: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return async () => {
    if (tenantId) {
      await queryClient.invalidateQueries({ queryKey: planKey(tenantId, admissionId) });
    }
  };
}

/** Saves the discharge advice. */
export function useSaveAdvice(admissionId: string) {
  const keyFor = useAttempt();
  const refresh = useRefreshPlan(admissionId);
  return useMutation({
    gcTime: 0,
    mutationFn: ({ advice, version }: { advice: string; version: number }) =>
      putDischargeAdvice(admissionId, advice, keyFor({ admissionId, advice, version })),
    onSettled: refresh,
  });
}

/** Marks one clearance cleared, or open again. */
export function useSetClearance(admissionId: string) {
  const keyFor = useAttempt();
  const refresh = useRefreshPlan(admissionId);
  return useMutation({
    gcTime: 0,
    mutationFn: (change: {
      kind: ClearanceKind;
      status: 'pending' | 'cleared';
      note?: string;
      /** The plan's version when the person acted: a repeat of an older body is a new request. */
      version: number;
    }) => {
      const { kind, version: _version, ...body } = change;
      return putDischargeClearance(admissionId, kind, body, keyFor({ admissionId, ...change }));
    },
    onSettled: refresh,
  });
}
