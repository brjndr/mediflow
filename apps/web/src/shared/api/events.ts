import { isApiError } from './errors';

/** One server-sent event, as the stream gave it. `data` is text: the caller parses it. */
export interface ServerEvent {
  /** `message` when the server named none. */
  event: string;
  data: string;
  id?: string;
}

/**
 * `live` while the stream is open, `retrying` after it was lost and before it is open again, and
 * `stopped` when the server refused it in a way trying again cannot mend (401, 403, 404, 409).
 */
export type EventStreamStatus = 'live' | 'retrying' | 'stopped';

export interface EventStreamOptions {
  /**
   * Opens the stream through the typed client, so it carries the session cookie, the tenant
   * header and the client's error handling:
   * `api.GET('/x/events', { parseAs: 'stream', signal })`, then its body.
   */
  connect: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: EventStreamStatus) => void;
  /** Aborting it closes the stream and ends the returned promise: navigation, sign-out, switch. */
  signal: AbortSignal;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * A stream that brings nothing for this long, not even the server's keep-alive comment, is
   * taken as lost and opened again: a connection dropped by a proxy, a sleeping laptop or a
   * change of network does not always close. Set it well above the server's keep-alive interval.
   */
  idleTimeoutMs?: number;
}

/** A cancel of a stream that has already failed rejects: there is nothing left to close. */
const ignore = () => {};

/** A stream open at least this long before the server closed it was working: no backoff. */
const STABLE_MS = 10_000;

/**
 * Characters of one unfinished line, or of one event's data, held at most. A server or proxy
 * that sends more without ending them is a failed stream, not something to keep in memory.
 */
const MAX_PENDING = 64 * 1024;

/** Refusals that the same request will meet again: the screen falls back to reading on its own. */
const FINAL_STATUSES = new Set([401, 403, 404, 409]);

/**
 * Splits a stream of bytes into server-sent events (the WHATWG event stream format): fields per
 * line, an event per blank line, comment lines ignored. Resolves when the stream ends; rejects
 * when it fails, holds too much, or brings nothing for `idleTimeoutMs`.
 */
export async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ServerEvent) => void,
  onRetry: (ms: number) => void = () => {},
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): Promise<void> {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(ignore);
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  let quiet = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    if (idleTimeoutMs === undefined) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      quiet = true;
      cancel();
    }, idleTimeoutMs);
  };
  watch();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  /** Characters of data held for the event being read. */
  let held = 0;
  let event = '';
  let id: string | undefined;

  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) {
        onEvent({ event: event || 'message', data: data.join('\n'), ...(id ? { id } : {}) });
      }
      data = [];
      held = 0;
      event = '';
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      held += value.length;
      if (held > MAX_PENDING) throw new TypeError('Event too large');
    } else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) onRetry(Number(value));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (quiet) throw new TypeError('The stream went quiet');
      watch();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0) break;
        // A carriage return at the end of what has come may be the first half of a CRLF.
        if (buffer[end] === '\r' && end === buffer.length - 1 && !done) break;
        line(buffer.slice(0, end));
        const crlf = buffer[end] === '\r' && buffer[end + 1] === '\n';
        buffer = buffer.slice(end + (crlf ? 2 : 1));
      }
      if (buffer.length > MAX_PENDING) throw new TypeError('Line too long');
      if (done) return;
    }
  } catch (error) {
    // Cancelled by the caller: the stream ends quietly.
    if (signal?.aborted) return;
    throw error;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', cancel);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Follows a server-sent event stream until `signal` is aborted: it opens the stream, hands each
 * event over, and opens it again when it ends or fails, after a growing wait with jitter, the
 * server's `retry:` or its Retry-After. A refusal in `FINAL_STATUSES` stops it (`stopped`).
 *
 * Read with `fetch`, not `EventSource`: it goes through the API client like every other call, is
 * aborted the same way, and works in the test environment, which has no `EventSource`.
 */
export async function followEventStream({
  connect,
  onEvent,
  onStatus = () => {},
  signal,
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
  idleTimeoutMs = 45_000,
}: EventStreamOptions): Promise<void> {
  /** A growing wait with jitter: between half and all of base * 2^(failures - 1), capped. */
  const backoff = (failures: number) => {
    const ceiling = Math.min(baseDelayMs * 2 ** (failures - 1), maxDelayMs);
    return ceiling / 2 + Math.random() * (ceiling / 2);
  };
  let failures = 0;
  let serverRetryMs: number | undefined;
  while (!signal.aborted) {
    let delay: number;
    try {
      const stream = await connect(signal);
      if (signal.aborted) {
        void stream.cancel().catch(ignore);
        return;
      }
      onStatus('live');
      const openedAt = Date.now();
      await readEventStream(stream, onEvent, (ms) => (serverRetryMs = ms), signal, idleTimeoutMs);
      if (signal.aborted) return;
      // The server closed it, as a server restarting or a proxy timing out does. One closed soon
      // after it opened (a proxy that drops every stream) counts as a failure, so the wait grows
      // and a board never opens it again and again. The server's own wait is kept in bounds.
      failures = Date.now() - openedAt >= STABLE_MS ? 0 : failures + 1;
      const asked = Math.min(Math.max(serverRetryMs ?? baseDelayMs, baseDelayMs), maxDelayMs);
      delay = failures > 0 ? Math.max(asked, backoff(failures)) : asked * (1 + Math.random());
    } catch (error) {
      if (signal.aborted) return;
      if (isApiError(error) && error.status !== undefined && FINAL_STATUSES.has(error.status)) {
        onStatus('stopped');
        return;
      }
      failures += 1;
      const retryAfter = isApiError(error) ? error.retryAfterMs : undefined;
      delay = Math.min(retryAfter ?? backoff(failures), maxDelayMs);
    }
    onStatus('retrying');
    await wait(delay, signal);
  }
}
