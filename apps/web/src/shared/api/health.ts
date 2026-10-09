import type { components } from '@mediflow/contract';
import { useQuery } from '@tanstack/react-query';
import { env } from '@/shared/config/env';

export type Health = components['schemas']['Health'];

const API_BASE = env.apiBaseUrl;

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_BASE}/health`, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return (await res.json()) as Health;
}

/** Health is not tenant data, so its key is not tenant-scoped. All tenant data keys are (CLAUDE.md). */
export function useHealth() {
  return useQuery({ queryKey: ['system', 'health'], queryFn: ({ signal }) => fetchHealth(signal) });
}
