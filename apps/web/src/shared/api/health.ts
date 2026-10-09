import type { components } from '@mediflow/contract';
import { useQuery } from '@tanstack/react-query';
import { api, requireData } from './client';

export type Health = components['schemas']['Health'];

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return requireData(await api.GET('/health', { signal }));
}

/** Health is not tenant data, so its key is not tenant-scoped. All tenant data keys are (CLAUDE.md). */
export function useHealth() {
  return useQuery({ queryKey: ['system', 'health'], queryFn: ({ signal }) => fetchHealth(signal) });
}
