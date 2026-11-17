import { api, requireData } from '@/shared/api';
import {
  bloodCollectionSchema,
  donorPageSchema,
  donorSchema,
  donorTraceSchema,
} from './donor-schemas';
import {
  bloodUnitSchema,
  compatibleUnitsSchema,
  crossmatchSchema,
  patientBloodGroupSchema,
  reactionPageSchema,
  reactionSchema,
  screeningSchema,
  stockSchema,
  traceSchema,
  unitDetailSchema,
  unitPageSchema,
} from './schemas';
import type {
  BloodCollection,
  BloodCollectionCreate,
  BloodDonor,
  BloodDonorCreate,
  BloodDonorDefer,
  BloodDonorPage,
  BloodDonorTrace,
  BloodDonorUpdate,
  DonorStatus,
  PatientBloodGroupSet,
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
  TransfusionReactionPage,
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

export interface ReactionFilters {
  severity?: ReactionSeverity;
}

/** Newest first, as the server orders them. */
export async function fetchReactions(
  { filters, cursor, limit }: { filters: ReactionFilters; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<TransfusionReactionPage> {
  const result = await api.GET('/transfusion-reactions', {
    params: { query: { ...filters, cursor, limit } },
    signal,
  });
  return reactionPageSchema.parse(requireData(result));
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

export interface DonorFilters {
  q?: string;
  bloodGroup?: BloodGroup;
  status?: DonorStatus;
}

/** The term travels in the body of a search, never in the address. */
export async function searchDonors(
  { filters, cursor, limit }: { filters: DonorFilters; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<BloodDonorPage> {
  const result = await api.POST('/blood/donors/search', {
    body: { ...filters, ...(cursor ? { cursor } : {}), limit },
    signal,
  });
  return donorPageSchema.parse(requireData(result));
}

/** The full record, name and phone included. The server audits this as a read. */
export async function fetchDonor(donorId: string, signal?: AbortSignal): Promise<BloodDonor> {
  const result = await api.GET('/blood/donors/{donorId}', {
    params: { path: { donorId } },
    signal,
  });
  return donorSchema.parse(requireData(result));
}

export async function fetchDonorTrace(
  donorId: string,
  signal?: AbortSignal,
): Promise<BloodDonorTrace> {
  const result = await api.GET('/blood/donors/{donorId}/trace', {
    params: { path: { donorId } },
    signal,
  });
  return donorTraceSchema.parse(requireData(result));
}

export async function registerDonor(body: BloodDonorCreate, key: string): Promise<BloodDonor> {
  const result = await api.POST('/blood/donors', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return donorSchema.parse(requireData(result));
}

export async function updateDonor(donorId: string, body: BloodDonorUpdate): Promise<BloodDonor> {
  const result = await api.PATCH('/blood/donors/{donorId}', {
    params: { path: { donorId } },
    body,
  });
  return donorSchema.parse(requireData(result));
}

export async function deferDonor(
  donorId: string,
  body: BloodDonorDefer,
  key: string,
): Promise<BloodDonor> {
  const result = await api.POST('/blood/donors/{donorId}/defer', {
    params: { path: { donorId }, header: { 'idempotency-key': key } },
    body,
  });
  return donorSchema.parse(requireData(result));
}

export async function recordCollection(
  body: BloodCollectionCreate,
  key: string,
): Promise<BloodCollection> {
  const result = await api.POST('/blood/collections', {
    params: { header: { 'idempotency-key': key } },
    body,
  });
  return bloodCollectionSchema.parse(requireData(result));
}

export async function setPatientBloodGroup(
  patientId: string,
  body: PatientBloodGroupSet,
  key: string,
): Promise<PatientBloodGroup> {
  const result = await api.POST('/patients/{patientId}/blood-group', {
    params: { path: { patientId }, header: { 'idempotency-key': key } },
    body,
  });
  return patientBloodGroupSchema.parse(requireData(result));
}
