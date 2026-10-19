import { ApiError } from './errors';
import { followEventStream, readEventStream, type ServerEvent } from './events';

const encoder = new TextEncoder();

/** A stream that gives these chunks, then ends, or stays open while `open` is set. */
function streamOf(chunks: string[], { open = false } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!open) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

async function eventsOf(chunks: string[]) {
  const events: ServerEvent[] = [];
  const retries: number[] = [];
  await readEventStream(
    streamOf(chunks).stream,
    (event) => events.push(event),
    (ms) => retries.push(ms),
  );
  return { events, retries };
}

describe('readEventStream', () => {
  it('reads events, their names, ids and lines of data', async () => {
    const { events } = await eventsOf([
      'event: queue\ndata: {"a":1}\n\n',
      'data: one\ndata: two\nid: 7\n\n',
    ]);
    expect(events).toEqual([
      { event: 'queue', data: '{"a":1}' },
      { event: 'message', data: 'one\ntwo', id: '7' },
    ]);
  });

  it('joins an event split across chunks anywhere, CRLF included', async () => {
    const { events } = await eventsOf(['ev', 'ent: q\r', '\ndata: x', 'y\r\n\r', '\n']);
    expect(events).toEqual([{ event: 'q', data: 'xy' }]);
  });

  it('ignores comments, unknown fields and an event with no data', async () => {
    const { events } = await eventsOf([': ping\n\n', 'event: lonely\n\n', 'foo: bar\ndata\n\n']);
    expect(events).toEqual([{ event: 'message', data: '' }]);
  });

  it('passes on the retry the server asks for, and only a number', async () => {
    const { retries } = await eventsOf(['retry: 2500\n', 'retry: soon\n\n']);
    expect(retries).toEqual([2500]);
  });

  it('needs no retry handler', async () => {
    const events: ServerEvent[] = [];
    await readEventStream(streamOf(['retry: 10\ndata: x\n\n']).stream, (event) =>
      events.push(event),
    );
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('fails when the stream fails, unless it was cancelled', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('connection reset'));
      },
    });
    await expect(readEventStream(broken, () => {})).rejects.toThrow('connection reset');
  });

  it('ends quietly when the stream fails because it was aborted', async () => {
    const controller = new AbortController();
    const failing = new ReadableStream<Uint8Array>({
      start(source) {
        // The server's side gives up first, before the reader is cancelled.
        controller.signal.addEventListener('abort', () => source.error(new Error('aborted')));
      },
    });
    const reading = readEventStream(failing, () => {}, undefined, controller.signal);
    controller.abort();
    await expect(reading).resolves.toBeUndefined();
  });

  it('fails rather than hold a line or an event that never ends', async () => {
    const long = 'x'.repeat(70 * 1024);
    await expect(readEventStream(streamOf([long]).stream, () => {})).rejects.toThrow(
      'Line too long',
    );
    const lines = Array.from({ length: 70 }, () => `data: ${'y'.repeat(1024)}\n`).join('');
    await expect(readEventStream(streamOf([lines]).stream, () => {})).rejects.toThrow(
      'Event too large',
    );
  });

  it('drops an event the stream ended in the middle of', async () => {
    const { events } = await eventsOf(['data: half']);
    expect(events).toEqual([]);
  });

  it('cancels the stream when the signal is aborted, and ends quietly', async () => {
    const { stream, cancelled } = streamOf(['data: first\n\n'], { open: true });
    const controller = new AbortController();
    const events: ServerEvent[] = [];
    const reading = readEventStream(
      stream,
      (event) => events.push(event),
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort();
    await expect(reading).resolves.toBeUndefined();
    expect(cancelled()).toBe(true);
  });
});

describe('followEventStream', () => {
  it('opens again after the server closes the stream, and hands over every event', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const statuses: string[] = [];
    let opened = 0;
    const done = followEventStream({
      connect: () => {
        opened += 1;
        // The second stream stays open until the test aborts.
        return Promise.resolve(streamOf([`data: ${opened}\n\n`], { open: opened > 1 }).stream);
      },
      onEvent: (event) => events.push(event.data),
      onStatus: (status) => statuses.push(status),
      signal: controller.signal,
      baseDelayMs: 1,
    });
    await vi.waitFor(() => expect(events).toEqual(['1', '2']));
    controller.abort();
    await done;
    expect(statuses).toEqual(['live', 'retrying', 'live']);
  });

  it('tries again after a failure, waiting at least the Retry-After', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let opened = 0;
      const statuses: string[] = [];
      const done = followEventStream({
        connect: () => {
          opened += 1;
          if (opened === 1) {
            return Promise.reject(
              new ApiError({ code: 'rate_limited', status: 429, retryAfterMs: 5_000 }),
            );
          }
          return Promise.resolve(streamOf([], { open: true }).stream);
        },
        onEvent: () => {},
        onStatus: (status) => statuses.push(status),
        signal: controller.signal,
        baseDelayMs: 1,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(opened).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toBe(2);
      expect(statuses).toEqual(['retrying', 'live']);
      controller.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits the retry the server asked for before opening a closed stream again', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let opened = 0;
      const done = followEventStream({
        connect: () => {
          opened += 1;
          return Promise.resolve(streamOf(['retry: 3000\n\n'], { open: opened > 1 }).stream);
        },
        onEvent: () => {},
        signal: controller.signal,
        baseDelayMs: 1,
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(opened).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(opened).toBe(2);
      controller.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a stream that brings nothing, not even a keep-alive, as lost and opens it again', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let opened = 0;
      const statuses: string[] = [];
      const first = streamOf([], { open: true });
      const done = followEventStream({
        connect: () => {
          opened += 1;
          return Promise.resolve(opened === 1 ? first.stream : streamOf([], { open: true }).stream);
        },
        onEvent: () => {},
        onStatus: (status) => statuses.push(status),
        signal: controller.signal,
        baseDelayMs: 1,
        idleTimeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(opened).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(first.cancelled()).toBe(true);
      expect(opened).toBe(2);
      expect(statuses).toEqual(['live', 'retrying', 'live']);
      controller.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stream that brings keep-alive comments', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          source = c;
        },
      });
      let opened = 0;
      const done = followEventStream({
        connect: () => {
          opened += 1;
          return Promise.resolve(stream);
        },
        onEvent: () => {},
        signal: controller.signal,
        idleTimeoutMs: 1_000,
      });
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(800);
        source?.enqueue(encoder.encode(': ping\n\n'));
      }
      expect(opened).toBe(1);
      controller.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits longer each time a stream is closed as soon as it opens, within the bounds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const controller = new AbortController();
      const openedAt: number[] = [];
      const done = followEventStream({
        // A proxy that drops every stream at once, asking for no wait at all.
        connect: () => {
          openedAt.push(Date.now());
          return Promise.resolve(streamOf(['retry: 0\n\n']).stream);
        },
        onEvent: () => {},
        signal: controller.signal,
        baseDelayMs: 100,
        maxDelayMs: 400,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      controller.abort();
      await done;
      const waits = openedAt.slice(1).map((at, i) => at - (openedAt[i] ?? 0));
      expect(waits.slice(0, 4)).toEqual([100, 200, 400, 400]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404, 409])('stops for good on a %i', async (status) => {
    const statuses: string[] = [];
    const connect = vi.fn(() => Promise.reject(new ApiError({ code: 'forbidden', status })));
    await followEventStream({
      connect,
      onEvent: () => {},
      onStatus: (next) => statuses.push(next),
      signal: new AbortController().signal,
      baseDelayMs: 1,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['stopped']);
  });

  it('keeps trying after a network failure, with a growing wait', async () => {
    const controller = new AbortController();
    const connect = vi.fn(() => Promise.reject(new ApiError({ code: 'network' })));
    const done = followEventStream({
      connect,
      onEvent: () => {},
      signal: controller.signal,
      baseDelayMs: 1,
      maxDelayMs: 4,
    });
    await vi.waitFor(() => expect(connect.mock.calls.length).toBeGreaterThanOrEqual(4));
    controller.abort();
    await done;
  });

  it('ends at once when aborted while waiting to try again, or while connecting', async () => {
    const controller = new AbortController();
    const done = followEventStream({
      connect: () => Promise.reject(new ApiError({ code: 'server', status: 503 })),
      onEvent: () => {},
      signal: controller.signal,
      baseDelayMs: 60_000,
    });
    controller.abort();
    await expect(done).resolves.toBeUndefined();

    const late = new AbortController();
    const { stream, cancelled } = streamOf([], { open: true });
    const connecting = followEventStream({
      connect: () => {
        late.abort();
        return Promise.resolve(stream);
      },
      onEvent: () => {},
      signal: late.signal,
    });
    await connecting;
    expect(cancelled()).toBe(true);

    // A stream that failed meanwhile cannot be cancelled: that is no error either.
    const third = new AbortController();
    const failed = new ReadableStream<Uint8Array>({
      start(source) {
        source.error(new Error('gone'));
      },
    });
    await expect(
      followEventStream({
        connect: () => {
          third.abort();
          return Promise.resolve(failed);
        },
        onEvent: () => {},
        signal: third.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not start when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    await followEventStream({ connect, onEvent: () => {}, signal: controller.signal });
    expect(connect).not.toHaveBeenCalled();
  });
});
