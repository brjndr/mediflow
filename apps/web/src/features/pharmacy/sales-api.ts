import { api, requireData } from '@/shared/api';
import {
  registerPageSchema,
  saleItemOptionsSchema,
  salePageSchema,
  saleSchema,
} from './sales-schemas';
import type {
  DrugRegisterPage,
  PharmacySale,
  SaleCreate,
  SaleItemOptions,
  SalePage,
  SaleReturnCreate,
} from './types';

// Counter sales, their returns and the drug register (#101). Every address holds ids, dates and a
// number of days only; every POST carries an idempotency key, which the API requires.

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export interface RegisterFilters {
  drugId: string;
  /** `YYYY-MM-DD`, at the hospital. */
  from: string;
  to: string;
}

/** An item that may be sold at a place, with its batches nearest expiry first. */
export async function fetchSaleItemOptions(
  drugId: string,
  locationId: string,
  signal?: AbortSignal,
): Promise<SaleItemOptions> {
  const result = await api.GET('/pharmacy/sale-options', {
    params: { query: { drugId, locationId } },
    signal,
  });
  return saleItemOptionsSchema.parse(requireData(result));
}

export async function createSale(body: SaleCreate, key: string): Promise<PharmacySale> {
  const result = await api.POST('/pharmacy/sales', { body, params: idempotent(key) });
  return saleSchema.parse(requireData(result));
}

/** The hospital's sales within a number of days, the newest first. */
export async function fetchSales(
  { days, cursor, limit }: { days: number; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<SalePage> {
  const result = await api.GET('/pharmacy/sales', {
    params: { query: { days, cursor, limit } },
    signal,
  });
  return salePageSchema.parse(requireData(result));
}

export async function fetchSale(saleId: string, signal?: AbortSignal): Promise<PharmacySale> {
  const result = await api.GET('/pharmacy/sales/{saleId}', {
    params: { path: { saleId } },
    signal,
  });
  return saleSchema.parse(requireData(result));
}

export async function createSaleReturn(
  saleId: string,
  body: SaleReturnCreate,
  key: string,
): Promise<PharmacySale> {
  const result = await api.POST('/pharmacy/sales/{saleId}/returns', {
    params: { path: { saleId }, ...idempotent(key) },
    body,
  });
  return saleSchema.parse(requireData(result));
}

/** Records that a receipt is printed: the page prints only once this is answered. */
export async function recordReceiptPrint(saleId: string, key: string): Promise<void> {
  await api.POST('/pharmacy/sales/{saleId}/print', {
    params: { path: { saleId }, ...idempotent(key) },
  });
}

/** An item's register: its movements from the first day to the last, the oldest first. */
export async function fetchRegister(
  { drugId, from, to, cursor, limit }: RegisterFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<DrugRegisterPage> {
  const result = await api.GET('/pharmacy/register', {
    params: { query: { drugId, from, to, cursor, limit } },
    signal,
  });
  return registerPageSchema.parse(requireData(result));
}
