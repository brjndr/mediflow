import { api, requireData } from '@/shared/api';
import { rosterShiftPageSchema, rosterShiftSchema } from './schemas';
import type { RosterShift, RosterShiftCreate, RosterShiftPage } from './types';

// Addresses hold ids, instants and a page cursor only. Every POST carries an idempotency key.

export interface ShiftFilters {
  from?: string;
  to?: string;
  departmentId?: string;
}

export async function fetchShifts(
  { cursor, limit, ...filters }: ShiftFilters & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<RosterShiftPage> {
  const result = await api.GET('/roster/shifts', {
    params: { query: { ...filters, cursor, limit } },
    signal,
  });
  return rosterShiftPageSchema.parse(requireData(result));
}

export async function createShift(
  body: RosterShiftCreate,
  idempotencyKey: string,
): Promise<RosterShift> {
  const result = await api.POST('/roster/shifts', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return rosterShiftSchema.parse(requireData(result));
}

export async function cancelShift(
  shiftId: string,
  version: number,
  idempotencyKey: string,
): Promise<RosterShift> {
  const result = await api.POST('/roster/shifts/{shiftId}/cancel', {
    params: { path: { shiftId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return rosterShiftSchema.parse(requireData(result));
}
