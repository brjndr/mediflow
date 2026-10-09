import { ApiError, apiErrorFromResponse } from './errors';

export interface ApiFetchOptions {
  /** Active tenant for the `X-Tenant-ID` consistency header. The server never trusts it. */
  getTenantId: () => string | undefined;
  /** Called on a 401 (session missing or expired). */
  onUnauthorized: () => void;
  /** Called on a 403 (the access policy may be stale). */
  onForbidden: () => void;
  /** Called when the server says this tab's tenant is stale (409 tenant_mismatch). */
  onTenantMismatch: () => void;
  timeoutMs: number;
  /** Total tries, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Upper bound for a single wait, including a server-sent Retry-After. */
  maxDelayMs: number;
}

export const TENANT_HEADER = 'X-Tenant-ID';
/** Server code for a request whose tenant header disagrees with the session's active tenant. */
export const TENANT_MISMATCH = 'tenant_mismatch';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Exponential backoff with jitter: between half and all of base * 2^(attempt - 1). */
function backoff(attempt: number, options: ApiFetchOptions): number {
  const ceiling = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** Retry-After is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One attempt, aborted by the caller's signal or by the timeout. */
async function attemptFetch(
  request: Request,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ApiError({ code: 'timeout' });
    if (callerSignal?.aborted || isAbort(error)) throw new DOMException('Aborted', 'AbortError');
    throw new ApiError({ code: 'network' });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Builds the app's fetch: cookies, tenant consistency header, timeout, retries and error mapping.
 * It resolves with 2xx/3xx responses only and throws ApiError for everything else, except caller
 * cancellation, which rethrows an AbortError so React Query treats it as a cancel.
 *
 * Retries: GET and HEAD on network errors, timeouts and 502/503/504. A 429 is retried for every
 * method because the server rejected the request before processing it.
 */
export function createApiFetch(getOptions: () => ApiFetchOptions): typeof fetch {
  return async function apiFetch(input, init) {
    const options = getOptions();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const base = new Request(input, { ...init, signal: undefined, credentials: 'include' });
    const tenantId = options.getTenantId();
    if (tenantId) base.headers.set(TENANT_HEADER, tenantId);
    const idempotent = IDEMPOTENT_METHODS.has(base.method.toUpperCase());

    for (let attempt = 1; ; attempt++) {
      const canRetry = attempt < options.maxAttempts;
      let response: Response;
      try {
        response = await attemptFetch(base.clone(), callerSignal ?? undefined, options.timeoutMs);
      } catch (error) {
        if (error instanceof ApiError && idempotent && canRetry) {
          await wait(backoff(attempt, options), callerSignal ?? undefined);
          continue;
        }
        throw error;
      }

      if (response.ok || (response.status >= 300 && response.status < 400)) return response;

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        if (canRetry) {
          const delay = Math.min(retryAfterMs ?? backoff(attempt, options), options.maxDelayMs);
          await wait(delay, callerSignal ?? undefined);
          continue;
        }
        throw await apiErrorFromResponse(response, retryAfterMs);
      }

      if (RETRYABLE_STATUSES.has(response.status) && idempotent && canRetry) {
        await wait(backoff(attempt, options), callerSignal ?? undefined);
        continue;
      }

      if (response.status === 401) options.onUnauthorized();
      if (response.status === 403) options.onForbidden();
      const error = await apiErrorFromResponse(response);
      if (error.serverCode === TENANT_MISMATCH) options.onTenantMismatch();
      throw error;
    }
  };
}
