import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useFeatureFlag, usePermission } from '@/access';
import { useTenant } from '@/tenancy';
import {
  applyDeposits,
  fetchDeposits,
  fetchDischargePolicy,
  fetchRunningBill,
  fetchSettlement,
  putDischargePolicy,
  refundDeposits,
  setEstimate,
  takeDeposit,
  type DepositCreate,
  type DischargePolicyMode,
} from '../stay-bill';
import { billingKeys, useRefreshBilling } from './use-billing';

// Keys sit under the billing keys, so anything that refreshes billing refreshes the running bill.
const stayKey = (tenantId: string, admissionId: string, part: string) =>
  [...billingKeys.all(tenantId), 'stay', admissionId, part] as const;

/** The stay's bill added up from the charge ledger, read again after any billing change. */
export function useRunningBill(admissionId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: stayKey(tenantId ?? '', admissionId, 'bill'),
    queryFn: ({ signal }) => fetchRunningBill(admissionId, signal),
    enabled: tenantId !== undefined && admissionId !== '',
    staleTime: 0,
  });
}

/** The deposits taken against the stay, for `payment:read`. */
export function useDeposits(admissionId: string, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: stayKey(tenantId ?? '', admissionId, 'deposits'),
    queryFn: ({ signal }) => fetchDeposits(admissionId, signal),
    enabled: enabled && tenantId !== undefined && admissionId !== '',
  });
}

/** One key per body until it is answered: a double press or a retry takes one deposit. */
function useKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return {
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
  };
}

export function useTakeDeposit(admissionId: string) {
  const refresh = useRefreshBilling();
  const keys = useKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: DepositCreate) => takeDeposit(admissionId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** The final bill and settlement of the stay, read again after any billing change. */
export function useSettlement(admissionId: string, { enabled = true } = {}) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: stayKey(tenantId ?? '', admissionId, 'settlement'),
    queryFn: ({ signal }) => fetchSettlement(admissionId, signal),
    enabled: enabled && tenantId !== undefined && admissionId !== '',
    staleTime: 0,
  });
}

/**
 * Whether the bill lets a patient be discharged under the hospital's policy, for the admissions
 * screen. Nothing is read without `charge:read` and the billing switch: then the bill gates
 * nothing here (the server decides) and `available` is false.
 */
export function useDischargeClearance(admissionId: string) {
  const canRead = usePermission('charge:read');
  const billing = useFeatureFlag('billing');
  const allowed = canRead && billing;
  const found = useSettlement(admissionId, { enabled: allowed });
  return {
    available: allowed,
    pending: allowed && found.isPending,
    failed: allowed && found.isError,
    settlement: found.data,
  };
}

/** Sets the deposits held against an issued invoice. One key per invoice until it is answered. */
export function useApplyDeposits(admissionId: string) {
  const refresh = useRefreshBilling();
  const keys = useKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (invoiceId: string) =>
      applyDeposits(admissionId, invoiceId, keys.keyFor({ invoiceId })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Pays back the excess deposit. One key per body; the reason is not kept (`gcTime: 0`). */
export function useRefundDeposits(admissionId: string) {
  const refresh = useRefreshBilling();
  const keys = useKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: { amountMinor: number; method: DepositCreate['method']; reason: string }) =>
      refundDeposits(admissionId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useDischargePolicy() {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: [...billingKeys.all(tenantId ?? ''), 'discharge-policy'] as const,
    queryFn: ({ signal }) => fetchDischargePolicy(signal),
    enabled: tenantId !== undefined,
  });
}

export function useSetDischargePolicy() {
  const refresh = useRefreshBilling();
  const keys = useKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (mode: DischargePolicyMode) => putDischargePolicy(mode, keys.keyFor({ mode })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useSetEstimate(admissionId: string) {
  const refresh = useRefreshBilling();
  const keys = useKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: { amountMinor: number; note?: string }) =>
      setEstimate(admissionId, body, keys.keyFor(body)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
