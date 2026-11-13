import { api, requireData } from '@/shared/api';
import {
  carePlanPageSchema,
  carePlanSchema,
  fluidTotalsSchema,
  wardFluidPageSchema,
  wardFluidSchema,
} from './care-schemas';
import type {
  CarePlan,
  CarePlanCreate,
  CarePlanPage,
  CarePlanTaskCreate,
  FluidTotals,
  WardFluid,
  WardFluidCorrect,
  WardFluidCreate,
  WardFluidPage,
} from './types';

/** Fluid entries of a stay between two instants (from included, to excluded), newest first. */
export async function fetchFluids(
  {
    admissionId,
    from,
    to,
    cursor,
    limit,
  }: { admissionId: string; from: string; to: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<WardFluidPage> {
  const result = await api.GET('/admissions/{admissionId}/fluids', {
    params: { path: { admissionId }, query: { from, to, cursor, limit } },
    signal,
  });
  return wardFluidPageSchema.parse(requireData(result));
}

/** What was taken in and put out between two instants, worked out by the server. */
export async function fetchFluidTotals(
  admissionId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<FluidTotals> {
  const result = await api.GET('/admissions/{admissionId}/fluids/totals', {
    params: { path: { admissionId }, query: { from, to } },
    signal,
  });
  return fluidTotalsSchema.parse(requireData(result));
}

export async function recordFluid(
  admissionId: string,
  body: WardFluidCreate,
  key: string,
): Promise<WardFluid> {
  const result = await api.POST('/admissions/{admissionId}/fluids', {
    params: { path: { admissionId }, header: { 'idempotency-key': key } },
    body,
  });
  return wardFluidSchema.parse(requireData(result));
}

export async function correctFluid(
  admissionId: string,
  fluidId: string,
  body: WardFluidCorrect,
  key: string,
): Promise<WardFluid> {
  const result = await api.POST('/admissions/{admissionId}/fluids/{fluidId}/correct', {
    params: { path: { admissionId, fluidId }, header: { 'idempotency-key': key } },
    body,
  });
  return wardFluidSchema.parse(requireData(result));
}

// --- care plans ----------------------------------------------------------------------------------

export async function fetchCarePlans(
  { admissionId, cursor, limit }: { admissionId: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<CarePlanPage> {
  const result = await api.GET('/admissions/{admissionId}/care-plans', {
    params: { path: { admissionId }, query: { cursor, limit } },
    signal,
  });
  return carePlanPageSchema.parse(requireData(result));
}

export async function createCarePlan(
  admissionId: string,
  body: CarePlanCreate,
  key: string,
): Promise<CarePlan> {
  const result = await api.POST('/admissions/{admissionId}/care-plans', {
    params: { path: { admissionId }, header: { 'idempotency-key': key } },
    body,
  });
  return carePlanSchema.parse(requireData(result));
}

export async function addCarePlanTask(
  planId: string,
  body: CarePlanTaskCreate,
  key: string,
): Promise<CarePlan> {
  const result = await api.POST('/care-plans/{planId}/tasks', {
    params: { path: { planId }, header: { 'idempotency-key': key } },
    body,
  });
  return carePlanSchema.parse(requireData(result));
}

export async function completeCarePlanTask(taskId: string, note?: string): Promise<CarePlan> {
  const result = await api.POST('/care-plan-tasks/{taskId}/done', {
    params: { path: { taskId } },
    body: note === undefined ? {} : { note },
  });
  return carePlanSchema.parse(requireData(result));
}

export async function closeCarePlan(
  planId: string,
  status: 'completed' | 'cancelled',
): Promise<CarePlan> {
  const result = await api.POST('/care-plans/{planId}/close', {
    params: { path: { planId } },
    body: { status },
  });
  return carePlanSchema.parse(requireData(result));
}
