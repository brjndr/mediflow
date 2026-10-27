import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTenantKeys } from '@/shared/api';
import { useTenant } from '@/tenancy';
import {
  createSale,
  createSaleReturn,
  fetchRegister,
  fetchSale,
  fetchSaleItemOptions,
  fetchSales,
  recordReceiptPrint,
  type RegisterFilters,
} from '../sales-api';
import type { PharmacySale, SaleCreate, SaleReturnCreate } from '../types';
import { useIdempotencyKey, useStillHere } from './use-pharmacy';

/** Every key is prefixed with the tenant, so one hospital's sales never show in another. */
export const saleKeys = createTenantKeys('pharmacySales');
const saleOptionKeys = createTenantKeys('pharmacySaleOptions');
const registerKeys = createTenantKeys('drugRegister');

export const SALES_PAGE_SIZE = 25;
export const REGISTER_PAGE_SIZE = 50;

/** The hospital's sales within a number of days, a page at a time. */
export function useSales(days: number) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: saleKeys.list(tenantId ?? '', { days, limit: SALES_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchSales({ days, cursor: pageParam, limit: SALES_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: tenantId !== undefined,
  });
}

/** A sale, kept in memory only and dropped soon after the screen is left. */
export function useSale(saleId: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: saleKeys.detail(tenantId ?? '', saleId),
    queryFn: ({ signal }) => fetchSale(saleId, signal),
    enabled: tenantId !== undefined,
    gcTime: 30_000,
  });
}

/** Each item of the cart at a place, with its batches, read afresh for the place chosen. */
export function useSaleItemOptions(drugIds: readonly string[], locationId: string) {
  const tenantId = useTenant()?.id;
  return useQueries({
    queries: drugIds.map((drugId) => ({
      queryKey: saleOptionKeys.list(tenantId ?? '', { drugId, locationId }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchSaleItemOptions(drugId, locationId, signal),
      enabled: tenantId !== undefined && locationId !== '',
      gcTime: 0,
      staleTime: 0,
    })),
  });
}

/** Sells: one key per body, so a retry sells once; the list and the stock read again. */
export function useCreateSale() {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: SaleCreate) => createSale(body, keys.keyFor(body)),
    onSuccess: (sale: PharmacySale) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(saleKeys.detail(tenantId, sale.id), sale);
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (!tenantId) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: saleKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: saleOptionKeys.all(tenantId) }),
      ]);
    },
  });
}

/** Brings units of a sale back: one key per body; the sale and the list read again. */
export function useSaleReturn(saleId: string) {
  const queryClient = useQueryClient();
  const stillHere = useStillHere();
  const keys = useIdempotencyKey();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: SaleReturnCreate) => createSaleReturn(saleId, body, keys.keyFor(body)),
    onSuccess: (sale: PharmacySale) => {
      keys.clear();
      const tenantId = stillHere();
      if (tenantId) queryClient.setQueryData(saleKeys.detail(tenantId, saleId), sale);
    },
    onSettled: () => {
      const tenantId = stillHere();
      if (!tenantId) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: saleKeys.lists(tenantId) }),
        queryClient.invalidateQueries({ queryKey: saleKeys.detail(tenantId, saleId) }),
      ]);
    },
  });
}

/**
 * Printing a receipt: the print is recorded on the server first, with a new key per press; the
 * page is shown (`job`) only once that succeeded, for the session it was asked in, and dropped by
 * `done` when the print dialog closes.
 */
export function usePrintReceipt() {
  const stillHere = useStillHere();
  const [job, setJob] = useState<{ id: number; sale: PharmacySale } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (sale: PharmacySale) => {
      await recordReceiptPrint(sale.id, crypto.randomUUID());
      return sale;
    },
    onSuccess: (sale) => {
      if (stillHere() && live.current) setJob((now) => ({ id: (now?.id ?? 0) + 1, sale }));
    },
  });
  const done = useCallback(() => setJob(null), []);
  return { print: mutation.mutate, busy: mutation.isPending, error: mutation.error, job, done };
}

/** An item's register over the days asked, the oldest first, a page at a time. */
export function useRegister(filters: RegisterFilters | null) {
  const tenantId = useTenant()?.id;
  return useInfiniteQuery({
    queryKey: registerKeys.list(tenantId ?? '', { ...filters, limit: REGISTER_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchRegister(
        { ...(filters as RegisterFilters), cursor: pageParam, limit: REGISTER_PAGE_SIZE },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: tenantId !== undefined && filters !== null,
    gcTime: 30_000,
  });
}
