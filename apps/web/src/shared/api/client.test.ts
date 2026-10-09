import { delay, http, HttpResponse } from 'msw';
import { server } from '@/mocks/node';
import { fetchHealth } from './health';
import { ApiError, apiFetch, configureApi, resetApiConfig } from '.';

/** API client behaviour beyond the main retry, 401, 403 and 429 cases in http.test.ts. */

const URL_ITEMS = 'http://localhost:3000/api/items';

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the request to fail');
    },
    (error: unknown) => error,
  );
}

describe('429 with Retry-After as an HTTP date', () => {
  it('retries at the given time, not after the default backoff', async () => {
    // The default backoff is far longer than the test: only the date can make the retry prompt.
    configureApi({ baseDelayMs: 60_000 });
    let calls = 0;
    server.use(
      http.get(URL_ITEMS, () => {
        calls++;
        return calls === 1
          ? new HttpResponse(null, {
              status: 429,
              headers: { 'Retry-After': new Date(Date.now() - 1000).toUTCString() },
            })
          : HttpResponse.json({ items: [] });
      }),
    );
    const started = performance.now();
    await expect(apiFetch(URL_ITEMS)).resolves.toHaveProperty('status', 200);
    expect(calls).toBe(2);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('stops waiting when the caller aborts during the wait', async () => {
    let calls = 0;
    server.use(
      http.get(URL_ITEMS, () => {
        calls++;
        return new HttpResponse(null, { status: 429, headers: { 'Retry-After': '60' } });
      }),
    );
    const controller = new AbortController();
    const pending = caught(apiFetch(URL_ITEMS, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 40);
    expect(await pending).toHaveProperty('name', 'AbortError');
    expect(calls).toBe(1);
  });
});

describe('cancellation', () => {
  it('sends nothing when the signal is already aborted', async () => {
    let calls = 0;
    server.use(
      http.get(URL_ITEMS, () => {
        calls++;
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const error = await caught(apiFetch(URL_ITEMS, { signal: controller.signal }));
    expect(error).toHaveProperty('name', 'AbortError');
    await delay(20);
    expect(calls).toBe(0);
  });

  it('honours the signal of a Request object', async () => {
    server.use(
      http.get(URL_ITEMS, async () => {
        await delay(200);
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    const pending = caught(apiFetch(new Request(URL_ITEMS, { signal: controller.signal })));
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toHaveProperty('name', 'AbortError');
  });
});

describe('requests', () => {
  it('always sends cookies, whatever the caller asks for', async () => {
    server.use(http.get(URL_ITEMS, () => HttpResponse.json({})));
    // Observed where the request is handed to the platform: the mock server rebuilds requests
    // and does not preserve this field. The call still goes through to it.
    const platformFetch = vi.spyOn(globalThis, 'fetch');
    const sentCredentials = () =>
      platformFetch.mock.calls.map(([input]) =>
        input instanceof Request ? input.credentials : '',
      );

    await apiFetch(URL_ITEMS);
    await apiFetch(URL_ITEMS, { credentials: 'omit' });

    expect(sentCredentials()).toEqual(['include', 'include']);
  });

  it('resolves with a redirect-range response instead of treating it as an error', async () => {
    server.use(http.get(URL_ITEMS, () => new HttpResponse(null, { status: 304 })));
    await expect(apiFetch(URL_ITEMS)).resolves.toHaveProperty('status', 304);
  });
});

describe('error mapping', () => {
  it.each([
    [400, 'validation'],
    [409, 'conflict'],
    [418, 'unknown'],
    [422, 'validation'],
    [500, 'server'],
  ] as const)('maps %i to %s', async (status, code) => {
    server.use(http.get(URL_ITEMS, () => new HttpResponse(null, { status })));
    expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ code, status });
  });

  it('survives an error body that is not JSON, or is malformed JSON', async () => {
    server.use(
      http.get(
        URL_ITEMS,
        () =>
          new HttpResponse('<html><body>Bad Gateway nginx</body></html>', {
            status: 400,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    const html = await caught(apiFetch(URL_ITEMS));
    expect(html).toBeInstanceOf(ApiError);
    expect(html).toMatchObject({ code: 'validation', serverCode: undefined });

    server.use(
      http.get(
        URL_ITEMS,
        () =>
          new HttpResponse('{"error": {"code": "oops"', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({
      code: 'validation',
      serverCode: undefined,
    });
  });

  it.each([
    ['a body with no error object', { message: 'nope' }],
    ['an error that is not an object', { error: 'nope' }],
    ['an error with no code', { error: { message: 'nope' } }],
    ['a code that is not a string', { error: { code: 42 } }],
    ['a null body', null],
  ])('ignores %s', async (_what, body) => {
    server.use(http.get(URL_ITEMS, () => HttpResponse.json(body, { status: 400 })));
    expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ serverCode: undefined });
  });

  it('drops a request id that does not look like one', async () => {
    server.use(
      http.get(
        URL_ITEMS,
        () =>
          new HttpResponse(null, {
            status: 500,
            headers: { 'X-Request-Id': 'Jane Doe <jane@x.test>' },
          }),
      ),
    );
    expect(await caught(apiFetch(URL_ITEMS))).toMatchObject({ requestId: undefined });
  });
});

describe('typed client', () => {
  it('rejects when an endpoint that must return a body returns none', async () => {
    server.use(http.get('*/api/health', () => new HttpResponse(null, { status: 204 })));
    await expect(fetchHealth()).rejects.toThrow('Expected a response body');
  });
});

describe('configuration', () => {
  it('merges overrides and restores the defaults on reset', async () => {
    const onForbidden = vi.fn();
    const onUnauthorized = vi.fn();
    configureApi({ onForbidden });
    configureApi({ onUnauthorized });
    server.use(http.get(URL_ITEMS, () => new HttpResponse(null, { status: 403 })));
    await caught(apiFetch(URL_ITEMS));
    // The second call did not wipe out the first.
    expect(onForbidden).toHaveBeenCalledTimes(1);

    resetApiConfig();
    await caught(apiFetch(URL_ITEMS));
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
