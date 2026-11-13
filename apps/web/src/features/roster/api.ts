import { api, requireData } from '@/shared/api';
import {
  copyWeekResultSchema,
  rosterLeavePageSchema,
  rosterLeaveSchema,
  rosterShiftPageSchema,
  rosterShiftSchema,
  shiftSwapResultSchema,
  shiftTemplatePageSchema,
  shiftTemplateSchema,
} from './schemas';
import type {
  CopyWeekBody,
  CopyWeekResult,
  LeaveStatus,
  RosterLeave,
  RosterLeavePage,
  RosterShift,
  RosterShiftCreate,
  RosterShiftPage,
  ShiftSwapBody,
  ShiftSwapResult,
  ShiftTemplate,
  ShiftTemplateCreate,
  ShiftTemplatePage,
} from './types';

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

export async function fetchLeaves(
  {
    cursor,
    limit,
    ...filters
  }: { cursor?: string; limit: number; from?: string; to?: string; status?: LeaveStatus },
  signal?: AbortSignal,
): Promise<RosterLeavePage> {
  const result = await api.GET('/roster/leaves', {
    params: { query: { ...filters, cursor, limit } },
    signal,
  });
  return rosterLeavePageSchema.parse(requireData(result));
}

export async function requestLeave(
  body: { startsAt: string; endsAt: string },
  idempotencyKey: string,
): Promise<RosterLeave> {
  const result = await api.POST('/roster/leaves', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return rosterLeaveSchema.parse(requireData(result));
}

export type LeaveMove = 'approve' | 'reject' | 'cancel';

export async function moveLeave(
  move: LeaveMove,
  leaveId: string,
  version: number,
  idempotencyKey: string,
): Promise<RosterLeave> {
  const params = { path: { leaveId }, header: { 'idempotency-key': idempotencyKey } };
  const body = { version };
  const result =
    move === 'approve'
      ? await api.POST('/roster/leaves/{leaveId}/approve', { params, body })
      : move === 'reject'
        ? await api.POST('/roster/leaves/{leaveId}/reject', { params, body })
        : await api.POST('/roster/leaves/{leaveId}/cancel', { params, body });
  return rosterLeaveSchema.parse(requireData(result));
}

export async function fetchTemplates(
  { cursor, limit }: { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ShiftTemplatePage> {
  const result = await api.GET('/roster/templates', {
    params: { query: { cursor, limit } },
    signal,
  });
  return shiftTemplatePageSchema.parse(requireData(result));
}

export async function createTemplate(
  body: ShiftTemplateCreate,
  idempotencyKey: string,
): Promise<ShiftTemplate> {
  const result = await api.POST('/roster/templates', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return shiftTemplateSchema.parse(requireData(result));
}

export async function retireTemplate(
  templateId: string,
  version: number,
  idempotencyKey: string,
): Promise<ShiftTemplate> {
  const result = await api.POST('/roster/templates/{templateId}/retire', {
    params: { path: { templateId }, header: { 'idempotency-key': idempotencyKey } },
    body: { version },
  });
  return shiftTemplateSchema.parse(requireData(result));
}

export async function copyWeek(
  body: CopyWeekBody,
  idempotencyKey: string,
): Promise<CopyWeekResult> {
  const result = await api.POST('/roster/copy-week', {
    params: { header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return copyWeekResultSchema.parse(requireData(result));
}

export async function swapShift(
  shiftId: string,
  body: ShiftSwapBody,
  idempotencyKey: string,
): Promise<ShiftSwapResult> {
  const result = await api.POST('/roster/shifts/{shiftId}/swap', {
    params: { path: { shiftId }, header: { 'idempotency-key': idempotencyKey } },
    body,
  });
  return shiftSwapResultSchema.parse(requireData(result));
}
