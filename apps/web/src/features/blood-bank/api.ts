import { api, requireData } from '@/shared/api';
import { bloodUnitSchema, stockSchema, unitDetailSchema, unitPageSchema } from './schemas';
import type {
  BloodComponent,
  BloodGroup,
  BloodStock,
  BloodUnit,
  BloodUnitCreate,
  BloodUnitDetail,
  BloodUnitPage,
  BloodUnitStatus,
} from './types';

export interface UnitFilters {
  status?: BloodUnitStatus;
  bloodGroup?: BloodGroup;
  component?: BloodComponent;
}

/** Soonest expiry first, as the server orders them. */
export async function fetchUnits(
  { filters, cursor, limit }: { filters: UnitFilters; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<BloodUnitPage> {
  const result = await api.GET('/blood-units', {
    params: { query: { ...filters, cursor, limit } },
    signal,
  });
  return unitPageSchema.parse(requireData(result));
}

export async function fetchStock(signal?: AbortSignal): Promise<BloodStock> {
  const result = await api.GET('/blood-units/stock', { signal });
  return stockSchema.parse(requireData(result));
}

export async function fetchUnit(unitId: string, signal?: AbortSignal): Promise<BloodUnitDetail> {
  const result = await api.GET('/blood-units/{unitId}', {
    params: { path: { unitId } },
    signal,
  });
  return unitDetailSchema.parse(requireData(result));
}

export async function registerUnit(body: BloodUnitCreate, key: string): Promise<BloodUnit> {
  const result = await api.POST('/blood-units', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return bloodUnitSchema.parse(requireData(result));
}

export interface UnitMove {
  unit: BloodUnit;
  to: Exclude<BloodUnitStatus, 'collected'>;
  /** Needed to reserve a unit. */
  patientId?: string;
  /** Needed to discard a unit. */
  reason?: string;
}

export async function moveUnit(
  { unit, to, patientId, reason }: UnitMove,
  key: string,
): Promise<BloodUnit> {
  const result = await api.POST('/blood-units/{unitId}/move', {
    params: { path: { unitId: unit.id }, header: { 'idempotency-key': key } },
    body: {
      to,
      version: unit.version,
      ...(patientId === undefined ? {} : { patientId }),
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return bloodUnitSchema.parse(requireData(result));
}
