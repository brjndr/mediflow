import { api, requireData } from '@/shared/api';
import { departmentPageSchema, departmentSchema } from './schemas';
import type { Department, DepartmentCreate, DepartmentPage, DepartmentUpdate } from './types';

export async function fetchDepartments(
  { cursor, limit, archived }: { cursor?: string; limit: number; archived: boolean },
  signal?: AbortSignal,
): Promise<DepartmentPage> {
  const result = await api.GET('/departments', {
    params: { query: { cursor, limit, archived } },
    signal,
  });
  return departmentPageSchema.parse(requireData(result));
}

/**
 * Adds a department. The key makes a repeat of the same request (a double click, a retry after a
 * lost answer) add one department, not fail on its own name.
 */
export async function createDepartment(
  body: DepartmentCreate,
  idempotencyKey: string,
): Promise<Department> {
  const result = await api.POST('/departments', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return departmentSchema.parse(requireData(result));
}

export async function updateDepartment(
  departmentId: string,
  body: DepartmentUpdate,
): Promise<Department> {
  const result = await api.PATCH('/departments/{departmentId}', {
    params: { path: { departmentId } },
    body,
  });
  return departmentSchema.parse(requireData(result));
}

export async function archiveDepartment(departmentId: string): Promise<Department> {
  const result = await api.POST('/departments/{departmentId}/archive', {
    params: { path: { departmentId } },
  });
  return departmentSchema.parse(requireData(result));
}

export async function restoreDepartment(departmentId: string): Promise<Department> {
  const result = await api.POST('/departments/{departmentId}/restore', {
    params: { path: { departmentId } },
  });
  return departmentSchema.parse(requireData(result));
}
