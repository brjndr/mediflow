import type { components } from '@mediflow/contract';
import { api, requireData } from './client';

export type Health = components['schemas']['Health'];

/** The API's health check. Nothing on screen shows it since the home page dropped its status line (#1123). */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return requireData(await api.GET('/health', { signal }));
}
