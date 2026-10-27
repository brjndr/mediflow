import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createOrder,
  createSupplier,
  fetchOrder,
  fetchOrders,
  fetchReceipt,
  fetchReceipts,
  fetchReturns,
  fetchSuppliers,
  receiveGoods,
  returnToSupplier,
  setSupplierArchived,
  stepOrder,
  updateOrder,
  updateSupplier,
  type OrderStep,
} from '../api';
import type {
  GoodsReceiptCreate,
  PurchaseOrder,
  PurchaseOrderCreate,
  PurchaseOrderStatus,
  PurchaseOrderUpdate,
  PurchaseReturnCreate,
  Supplier,
  SupplierCreate,
  SupplierUpdate,
} from '../types';

/** Every key is prefixed with the tenant, so one hospital's purchasing never shows in another. */
export const purchasingKeys = createTenantKeys('purchasing');

export const PAGE_SIZE = 25;
/** Suppliers in use fill a form's list from one page. */
export const SUPPLIERS_IN_A_LIST = 100;

/**
 * The hospital, while the session is still the one the request was made in: an answer that
 * arrives after a sign-out, a time-out or a switch is never written.
 */
function useStillHere() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return useCallback(() => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return tenantId !== undefined &&
      userId !== undefined &&
      session?.user.id === userId &&
      session.activeTenant?.id === tenantId
      ? tenantId
      : undefined;
  }, [queryClient, tenantId, userId]);
}

/**
 * A key per request body: an identical resubmit (a double click, a retry) reuses it and is done
 * once, while another body gets a new key.
 */
function useIdempotencyKey() {
  const attempt = useRef<{ body: string; key: string }>(undefined);
  return useMemo(
    () => ({
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
    }),
    [],
  );
}

/** Whatever the answer, everything of purchasing is read again. */
function useRefresh() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  return () => {
    const tenantId = stillHere();
    if (tenantId) return queryClient.invalidateQueries({ queryKey: purchasingKeys.all(tenantId) });
  };
}

function usePaged<Page extends { nextCursor: string | null }, Filters extends object>(
  name: string,
  filters: Filters,
  fetchPage: (
    request: Filters & { cursor?: string; limit: number },
    signal: AbortSignal,
  ) => Promise<Page>,
  limit = PAGE_SIZE,
  enabled = true,
) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: purchasingKeys.list(tenantId ?? '', { name, ...filters, limit }),
    queryFn: ({ pageParam, signal }) => fetchPage({ ...filters, cursor: pageParam, limit }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: enabled && tenantId !== undefined,
  });
}

export const useSuppliers = (archived: boolean, enabled = true) =>
  usePaged('suppliers', { archived }, fetchSuppliers, SUPPLIERS_IN_A_LIST, enabled);

export const useOrders = (status: PurchaseOrderStatus | '') =>
  usePaged('orders', { status }, fetchOrders);

export const useReceipts = (orderId = '') => usePaged('receipts', { orderId }, fetchReceipts);

export const useReturns = (receiptId = '') => usePaged('returns', { receiptId }, fetchReturns);

export function useOrder(orderId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: purchasingKeys.detail(tenantId ?? '', `order:${orderId}`),
    queryFn: ({ signal }) => fetchOrder(orderId, signal),
    enabled: tenantId !== undefined && orderId !== '',
  });
}

export function useReceipt(receiptId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: purchasingKeys.detail(tenantId ?? '', `receipt:${receiptId}`),
    queryFn: ({ signal }) => fetchReceipt(receiptId, signal),
    enabled: tenantId !== undefined && receiptId !== '',
  });
}

export function useSaveSupplier() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    mutationFn: ({
      supplier,
      create,
      update,
    }: {
      supplier: Supplier | null;
      create: SupplierCreate;
      update: Omit<SupplierUpdate, 'expectedVersion'>;
    }) =>
      supplier
        ? updateSupplier(supplier.id, { expectedVersion: supplier.version, ...update })
        : createSupplier(create, keys.keyFor(create)),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useArchiveSupplier() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ supplier, archived }: { supplier: Supplier; archived: boolean }) =>
      setSupplierArchived(supplier.id, archived),
    onSettled: refresh,
  });
}

/**
 * Drafts an order, or changes a draft at the version it was read at, sending only the fields
 * `changed` (the lines as a whole).
 */
export function useSaveOrder() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      order,
      changed,
      create,
    }: {
      order: PurchaseOrder | null;
      changed: ('supplierId' | 'locationId' | 'note' | 'lines')[];
      create: PurchaseOrderCreate;
    }) => {
      if (!order) return createOrder(create, keys.keyFor(create));
      const update: PurchaseOrderUpdate = {
        expectedVersion: order.version,
        ...(changed.includes('supplierId') ? { supplierId: create.supplierId } : {}),
        ...(changed.includes('locationId') ? { locationId: create.locationId } : {}),
        ...(changed.includes('note') ? { note: create.note ?? null } : {}),
        ...(changed.includes('lines') ? { lines: create.lines } : {}),
      };
      return updateOrder(order.id, update);
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

/** Submits, approves, cancels or closes an order at the version it was read at. */
export function useStepOrder() {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      order,
      step,
      note,
    }: {
      order: PurchaseOrder;
      step: OrderStep;
      note?: string;
    }) => {
      const body = { expectedVersion: order.version, ...(note === undefined ? {} : { note }) };
      return stepOrder(order.id, step, body, keys.keyFor({ id: order.id, step, ...body }));
    },
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useReceiveGoods(orderId: string) {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: GoodsReceiptCreate) =>
      receiveGoods(orderId, body, keys.keyFor({ orderId, ...body })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}

export function useReturnToSupplier(receiptId: string) {
  const refresh = useRefresh();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: PurchaseReturnCreate) =>
      returnToSupplier(receiptId, body, keys.keyFor({ receiptId, ...body })),
    onSuccess: () => keys.clear(),
    onSettled: refresh,
  });
}
