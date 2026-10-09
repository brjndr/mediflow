import { http, HttpResponse, delay } from 'msw';
import { server } from '@/mocks/node';
import { createI18n } from '@/app/i18n';
import { ApiError, apiFetch, configureApi, errorMessageKey, TENANT_HEADER } from '@/shared/api';
import { parseRetryAfter } from './http';

const URL_ITEMS = 'http://localhost:3000/api/items';

/** Responds with each entry in turn, repeating the last one, and counts the calls. */
function respondInTurn(method: 'get' | 'post', responses: (() => Response)[]) {
  const calls: Request[] = [];
  server.use(
    http[method](URL_ITEMS, ({ request }) => {
      calls.push(request);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (!next) throw new Error('No response configured');
      return next();
    }),
  );
  return calls;
}

const ok = () => HttpResponse.json({ items: [] });
const status = (code: number, init?: ResponseInit) => () =>
  new HttpResponse(null, { status: code, ...init });

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the request to fail');
    },
    (error: unknown) => error,
  );
}

describe('apiFetch', () => {
  describe('retry', () => {
    it('retries an idempotent request after a 503 and resolves', async () => {
      const calls = respondInTurn('get', [status(503), status(502), ok]);
      const response = await apiFetch(URL_ITEMS);
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(3);
    });

    it('retries an idempotent request after a network error', async () => {
      const calls = respondInTurn('get', [() => HttpResponse.error(), ok]);
      await expect(apiFetch(URL_ITEMS)).resolves.toHaveProperty('status', 200);
      expect(calls).toHaveLength(2);
    });

    it('gives up after maxAttempts with a server error', async () => {
      const calls = respondInTurn('get', [status(503)]);
      const error = await caught(apiFetch(URL_ITEMS));
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'server', status: 503 });
      expect(calls).toHaveLength(3);
    });

    it('never retries a mutation on a server or network error', async () => {
      const calls = respondInTurn('post', [status(503), ok]);
      const error = await caught(apiFetch(URL_ITEMS, { method: 'POST', body: '{}' }));
      expect(error).toMatchObject({ code: 'server', status: 503 });
      expect(calls).toHaveLength(1);

      const failed = respondInTurn('post', [() => HttpResponse.error(), ok]);
      expect(await caught(apiFetch(URL_ITEMS, { method: 'POST', body: '{}' }))).toMatchObject({
        code: 'network',
        status: undefined,
      });
      expect(failed).toHaveLength(1);
    });

    it('does not retry client errors', async () => {
      const calls = respondInTurn('get', [status(404), ok]);
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ code: 'not_found' });
      expect(calls).toHaveLength(1);
    });
  });

  describe('401 and 403', () => {
    it('calls onUnauthorized on a 401 and throws without retrying', async () => {
      const onUnauthorized = vi.fn();
      const onForbidden = vi.fn();
      configureApi({ onUnauthorized, onForbidden });
      const calls = respondInTurn('get', [status(401), ok]);
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ code: 'unauthorized' });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onForbidden).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it('calls onForbidden on a 403 and throws without retrying', async () => {
      const onUnauthorized = vi.fn();
      const onForbidden = vi.fn();
      configureApi({ onUnauthorized, onForbidden });
      const calls = respondInTurn('get', [status(403), ok]);
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ code: 'forbidden' });
      expect(onForbidden).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });
  });

  describe('429', () => {
    it('waits for Retry-After before retrying', async () => {
      configureApi({ baseDelayMs: 10_000 });
      const calls = respondInTurn('get', [status(429, { headers: { 'Retry-After': '0.05' } }), ok]);
      const started = performance.now();
      await expect(apiFetch(URL_ITEMS)).resolves.toHaveProperty('status', 200);
      const elapsed = performance.now() - started;
      expect(calls).toHaveLength(2);
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(5_000);
    });

    it('retries a mutation, sending the body again', async () => {
      const bodies: string[] = [];
      let count = 0;
      server.use(
        http.post(URL_ITEMS, async ({ request }) => {
          bodies.push(await request.text());
          return ++count === 1
            ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '0' } })
            : HttpResponse.json({ id: 'item_1' }, { status: 201 });
        }),
      );
      const response = await apiFetch(URL_ITEMS, { method: 'POST', body: '{"name":"x"}' });
      expect(response.status).toBe(201);
      expect(bodies).toEqual(['{"name":"x"}', '{"name":"x"}']);
    });

    it('caps a long Retry-After at maxDelayMs', async () => {
      configureApi({ maxDelayMs: 20 });
      const calls = respondInTurn('get', [status(429, { headers: { 'Retry-After': '3600' } }), ok]);
      await expect(apiFetch(URL_ITEMS)).resolves.toHaveProperty('status', 200);
      expect(calls).toHaveLength(2);
    });

    it('throws rate_limited with the server delay once attempts run out', async () => {
      const calls = respondInTurn('get', [status(429, { headers: { 'Retry-After': '0' } })]);
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterMs: 0,
      });
      expect(calls).toHaveLength(3);
    });
  });

  describe('abort and timeout', () => {
    it('rejects with an AbortError when the caller aborts, without retrying', async () => {
      let calls = 0;
      server.use(
        http.get(URL_ITEMS, async () => {
          calls++;
          await delay(200);
          return ok();
        }),
      );
      const controller = new AbortController();
      const pending = caught(apiFetch(URL_ITEMS, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 20);
      const error = await pending;
      expect(error).toBeInstanceOf(DOMException);
      expect(error).toHaveProperty('name', 'AbortError');
      expect(calls).toBe(1);
    });

    it('stops waiting between retries when the caller aborts', async () => {
      configureApi({ baseDelayMs: 10_000 });
      const calls = respondInTurn('get', [status(503)]);
      const controller = new AbortController();
      const pending = caught(apiFetch(URL_ITEMS, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 50);
      expect(await pending).toHaveProperty('name', 'AbortError');
      expect(calls).toHaveLength(1);
    });

    it('throws a timeout error when the server is too slow', async () => {
      configureApi({ timeoutMs: 20, maxAttempts: 1 });
      server.use(
        http.get(URL_ITEMS, async () => {
          await delay(300);
          return ok();
        }),
      );
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({
        code: 'timeout',
        status: undefined,
      });
    });
  });

  describe('tenant header', () => {
    it('sends no tenant header until a tenant is active', async () => {
      const calls = respondInTurn('get', [ok]);
      await apiFetch(URL_ITEMS);
      expect(calls[0]?.headers.has(TENANT_HEADER)).toBe(false);
    });

    it('sends the active tenant on each request, following a tenant switch', async () => {
      let tenantId = 'tenant_1';
      configureApi({ getTenantId: () => tenantId });
      const calls = respondInTurn('get', [ok]);
      await apiFetch(URL_ITEMS);
      tenantId = 'tenant_2';
      await apiFetch(URL_ITEMS);
      expect(calls.map((request) => request.headers.get(TENANT_HEADER))).toEqual([
        'tenant_1',
        'tenant_2',
      ]);
    });
  });

  describe('error shape', () => {
    it('keeps the server code and request id but never the server message', async () => {
      const secret = 'Patient MRN-TEST-00001 not found in table patients';
      respondInTurn('get', [
        () =>
          HttpResponse.json(
            { error: { code: 'patient_not_found', message: secret, requestId: 'req_1' } },
            { status: 404, headers: { 'X-Request-Id': 'req_1' } },
          ),
      ]);
      const error = await caught(apiFetch(URL_ITEMS));
      expect(error).toMatchObject({
        code: 'not_found',
        status: 404,
        serverCode: 'patient_not_found',
        requestId: 'req_1',
        messageKey: 'errors.not_found',
      });
      expect(JSON.stringify(error)).not.toContain('MRN-TEST');
      expect((error as ApiError).message).toBe('not_found');
    });

    it('drops a server code that is free text', async () => {
      respondInTurn('get', [
        () =>
          HttpResponse.json(
            { error: { code: 'Jane Doe has no record', message: 'x' } },
            { status: 400 },
          ),
      ]);
      expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({
        code: 'validation',
        serverCode: undefined,
      });
    });

    it('has a translated message for every error code', () => {
      const i18n = createI18n();
      const codes = [
        'network',
        'timeout',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'validation',
        'rate_limited',
        'server',
        'unknown',
      ] as const;
      for (const code of codes) {
        const key = new ApiError({ code }).messageKey;
        expect(i18n.exists(key), key).toBe(true);
      }
      expect(errorMessageKey(new Error('raw'))).toBe('errors.unknown');
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Thu, 01 Jan 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
