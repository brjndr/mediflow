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

export async function createDepartment(body: DepartmentCreate): Promise<Department> {
  const result = await api.POST('/departments', { body });
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
