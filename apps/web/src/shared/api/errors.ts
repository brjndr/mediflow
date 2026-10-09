export type ApiErrorCode =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'unknown';

interface ApiErrorInit {
  code: ApiErrorCode;
  status?: number;
  serverCode?: string;
  requestId?: string;
  retryAfterMs?: number;
}

/**
 * The only error shape the API client throws. It never carries the server's message text, which
 * can hold patient data or internals: the UI shows the translation of `messageKey` instead.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status, or undefined when no response arrived (network failure, timeout). */
  readonly status: number | undefined;
  /** Stable machine-readable code from the server (e.g. `tenant_mismatch`), when it sent one. */
  readonly serverCode: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.code);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.serverCode = init.serverCode;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** i18n key (common namespace) of the user-facing message. */
  get messageKey(): string {
    return `errors.${this.code}`;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** i18n key for any thrown value, so views never render a raw error. */
export function errorMessageKey(error: unknown): string {
  return isApiError(error) ? error.messageKey : 'errors.unknown';
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

// Machine codes only. Anything that looks like free text is dropped.
const SERVER_CODE = /^[a-z][a-z0-9_.]{0,63}$/i;
const REQUEST_ID = /^[\w-]{1,128}$/;

async function readServerCode(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.includes('json')) return undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
    const error = body.error;
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' && SERVER_CODE.test(error.code) ? error.code : undefined;
  } catch {
    return undefined;
  }
}

export async function apiErrorFromResponse(
  response: Response,
  retryAfterMs?: number,
): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  return new ApiError({
    code: codeForStatus(response.status),
    status: response.status,
    serverCode: await readServerCode(response),
    requestId: requestId && REQUEST_ID.test(requestId) ? requestId : undefined,
    retryAfterMs,
  });
}
