import { api, requireData } from '@/shared/api';
import {
  adjustmentPageSchema,
  adjustmentSchema,
  alertCountsSchema,
  ledgerPageSchema,
  stockItemPageSchema,
  stockLocationPageSchema,
  stockLocationSchema,
} from './schemas';
import type {
  StockAdjustment,
  StockAdjustmentCreate,
  StockAdjustmentPage,
  StockAdjustmentStatus,
  StockAlert,
  StockAlertCounts,
  StockItemPage,
  StockLedgerPage,
  StockLocation,
  StockLocationKind,
  StockLocationPage,
} from './types';

// Every address holds ids, an alert, a status and a window of days: nothing about a patient, and
// no term typed by a person, so these are GETs. Every POST carries an idempotency key.

const idempotent = (key: string) => ({ header: { 'idempotency-key': key } });

export interface StockFilters {
  locationId: string;
  drugId: string;
  alert: StockAlert | '';
  expiringWithinDays: number;
}

export async function fetchStock(
  {
    locationId,
    drugId,
    alert,
    expiringWithinDays,
    cursor,
    limit,
  }: StockFilters & {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<StockItemPage> {
  const result = await api.GET('/inventory/stock', {
    params: {
      query: {
        locationId: locationId || undefined,
        drugId: drugId || undefined,
        alert: alert || undefined,
        expiringWithinDays,
        cursor,
        limit,
      },
    },
    signal,
  });
  return stockItemPageSchema.parse(requireData(result));
}

export async function fetchAlertCounts(
  { locationId, expiringWithinDays }: Pick<StockFilters, 'locationId' | 'expiringWithinDays'>,
  signal?: AbortSignal,
): Promise<StockAlertCounts> {
  const result = await api.GET('/inventory/stock/alerts', {
    params: { query: { locationId: locationId || undefined, expiringWithinDays } },
    signal,
  });
  return alertCountsSchema.parse(requireData(result));
}

export interface LedgerFilters {
  drugId: string;
  batchId: string;
  locationId: string;
  /** Instants: the hospital's day already turned into UTC. */
  from: string;
  to: string;
}

export async function fetchLedger(
  {
    drugId,
    batchId,
    locationId,
    from,
    to,
    cursor,
    limit,
  }: LedgerFilters & {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<StockLedgerPage> {
  const result = await api.GET('/inventory/ledger', {
    params: {
      query: {
        drugId: drugId || undefined,
        batchId: batchId || undefined,
        locationId: locationId || undefined,
        from: from || undefined,
        to: to || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return ledgerPageSchema.parse(requireData(result));
}

export async function fetchAdjustments(
  { status, cursor, limit }: { status: StockAdjustmentStatus; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<StockAdjustmentPage> {
  const result = await api.GET('/inventory/adjustments', {
    params: { query: { status, cursor, limit } },
    signal,
  });
  return adjustmentPageSchema.parse(requireData(result));
}

export async function createAdjustment(
  body: StockAdjustmentCreate,
  key: string,
): Promise<StockAdjustment> {
  const result = await api.POST('/inventory/adjustments', { body, params: idempotent(key) });
  return adjustmentSchema.parse(requireData(result));
}

export async function approveAdjustment(
  adjustmentId: string,
  body: { expectedVersion: number },
  key: string,
): Promise<StockAdjustment> {
  const result = await api.POST('/inventory/adjustments/{adjustmentId}/approve', {
    body,
    params: { path: { adjustmentId }, ...idempotent(key) },
  });
  return adjustmentSchema.parse(requireData(result));
}

export async function rejectAdjustment(
  adjustmentId: string,
  body: { expectedVersion: number; note: string },
  key: string,
): Promise<StockAdjustment> {
  const result = await api.POST('/inventory/adjustments/{adjustmentId}/reject', {
    body,
    params: { path: { adjustmentId }, ...idempotent(key) },
  });
  return adjustmentSchema.parse(requireData(result));
}

export async function fetchLocations(
  { archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<StockLocationPage> {
  const result = await api.GET('/inventory/locations', {
    params: { query: { archived, cursor, limit } },
    signal,
  });
  return stockLocationPageSchema.parse(requireData(result));
}

export async function createLocation(
  body: { name: string; kind: StockLocationKind },
  key: string,
): Promise<StockLocation> {
  const result = await api.POST('/inventory/locations', { body, params: idempotent(key) });
  return stockLocationSchema.parse(requireData(result));
}

export async function updateLocation(
  locationId: string,
  body: { expectedVersion: number; name?: string; kind?: StockLocationKind },
): Promise<StockLocation> {
  const result = await api.PATCH('/inventory/locations/{locationId}', {
    body,
    params: { path: { locationId } },
  });
  return stockLocationSchema.parse(requireData(result));
}

export async function setLocationArchived(
  locationId: string,
  archived: boolean,
): Promise<StockLocation> {
  const result = archived
    ? await api.POST('/inventory/locations/{locationId}/archive', {
        params: { path: { locationId } },
      })
    : await api.POST('/inventory/locations/{locationId}/restore', {
        params: { path: { locationId } },
      });
  return stockLocationSchema.parse(requireData(result));
}
