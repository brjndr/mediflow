import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTenant } from '@/tenancy';
import {
  fetchDeposits,
  fetchRunningBill,
  setEstimate,
  takeDeposit,
  type DepositCreate,
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
