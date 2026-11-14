import { api, requireData } from '@/shared/api';
import {
  bloodUnitSchema,
  compatibleUnitsSchema,
  crossmatchSchema,
  patientBloodGroupSchema,
  reactionSchema,
  screeningSchema,
  stockSchema,
  traceSchema,
  unitDetailSchema,
  unitPageSchema,
} from './schemas';
import type {
  BloodComponent,
  BloodCrossmatch,
  BloodGroup,
  BloodScreening,
  BloodScreeningCreate,
  BloodStock,
  BloodUnit,
  BloodUnitCreate,
  BloodUnitDetail,
  BloodUnitPage,
  BloodUnitStatus,
  BloodUnitTrace,
  CompatibleUnits,
  CrossmatchResult,
  PatientBloodGroup,
  ReactionSeverity,
  TransfusionReaction,
  TransfusionReactionCreate,
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

export async function recordScreening(
  unitId: string,
  body: BloodScreeningCreate,
  key: string,
): Promise<BloodScreening> {
  const result = await api.POST('/blood-units/{unitId}/screening', {
    params: { path: { unitId }, header: { 'idempotency-key': key } },
    body,
  });
  return screeningSchema.parse(requireData(result));
}

export async function recordCrossmatch(
  unitId: string,
  body: { patientId: string; result: CrossmatchResult },
  key: string,
): Promise<BloodCrossmatch> {
  const result = await api.POST('/blood-units/{unitId}/crossmatch', {
    params: { path: { unitId }, header: { 'idempotency-key': key } },
    body,
  });
  return crossmatchSchema.parse(requireData(result));
}

/** The patient is named by id in the body of a search, never in the address. */
export async function fetchCompatibleUnits(
  body: { patientId: string; component: BloodComponent },
  signal?: AbortSignal,
): Promise<CompatibleUnits> {
  const result = await api.POST('/blood/compatible-units', { body, signal });
  return compatibleUnitsSchema.parse(requireData(result));
}

export async function fetchPatientBloodGroup(
  patientId: string,
  signal?: AbortSignal,
): Promise<PatientBloodGroup> {
  const result = await api.GET('/patients/{patientId}/blood-group', {
    params: { path: { patientId } },
    signal,
  });
  return patientBloodGroupSchema.parse(requireData(result));
}

export async function recordReaction(
  body: TransfusionReactionCreate,
  key: string,
): Promise<TransfusionReaction> {
  const result = await api.POST('/transfusion-reactions', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return reactionSchema.parse(requireData(result));
}

export async function addReactionUpdate(
  reactionId: string,
  body: { note: string; severity?: ReactionSeverity },
  key: string,
): Promise<TransfusionReaction> {
  const result = await api.POST('/transfusion-reactions/{reactionId}/updates', {
    params: { path: { reactionId }, header: { 'idempotency-key': key } },
    body,
  });
  return reactionSchema.parse(requireData(result));
}

export async function fetchTrace(unitId: string, signal?: AbortSignal): Promise<BloodUnitTrace> {
  const result = await api.GET('/blood-units/{unitId}/trace', {
    params: { path: { unitId } },
    signal,
  });
  return traceSchema.parse(requireData(result));
}
