import type { paths } from '@mediflow/contract';
import createClient from 'openapi-fetch';
import { env } from '@/shared/config/env';
import { createApiFetch, type ApiFetchOptions } from './http';

const DEFAULTS: ApiFetchOptions = {
  getTenantId: () => undefined,
  onUnauthorized: () => {},
  onForbidden: () => {},
  onTenantMismatch: () => {},
  onTenantSuspended: () => {},
  timeoutMs: 15_000,
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 30_000,
};

let options: ApiFetchOptions = DEFAULTS;

/**
 * Wires the client to the rest of the app without the client importing it: the session (F-03),
 * tenancy (F-05) and access (F-07) layers register their hooks here.
 */
export function configureApi(overrides: Partial<ApiFetchOptions>): void {
  options = { ...options, ...overrides };
}

export function resetApiConfig(): void {
  options = DEFAULTS;
}

export const apiFetch = createApiFetch(() => options);

/** Typed client generated from the OpenAPI contract. Every API call goes through it. */
export const api = createClient<paths>({
  // Absolute, so requests resolve the same way in the browser and in tests.
  baseUrl: new URL(env.apiBaseUrl, window.location.origin).href,
  fetch: apiFetch,
});

/** Narrows a typed client result to its body. Use for endpoints that always return one. */
export function requireData<T>(result: { data?: T }): T {
  if (result.data === undefined) throw new TypeError('Expected a response body');
  return result.data;
}
