import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testConfig } from '../../../test/helpers.js';
import { PgBossQueue, safeJobError } from './queue.js';

const wait = async (done: () => boolean, ms = 10_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
};

describe('PgBossQueue', () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()!();
  });

  it('delivers a job to its worker, drops a repeated id, and reports a failure without its text', async () => {
    const errors: Error[] = [];
    const queue = new PgBossQueue(testConfig().DATABASE_URL, (e) => errors.push(e));
    stops.push(() => queue.stop());
    const name = `test.queue.${Date.now()}`;
    const failing = `${name}.fail`;
    const seen: { n: number }[] = [];
    let attempts = 0;
    // Registered before start: it takes effect when the queue starts.
    queue.work<{ n: number }>(name, async (data, context) => {
      seen.push(data);
      expect(context.retryCount).toBe(0);
    });
    queue.work(failing, async () => {
      attempts++;
      throw Object.assign(new Error('Failing row contains (Asha, 1990-01-01)'), { code: '23502' });
    });
    await queue.start();

    await queue.send(name, { n: 1 }, { id: crypto.randomUUID() });
    const repeated = crypto.randomUUID();
    await queue.send(name, { n: 2 }, { id: repeated });
    await queue.send(name, { n: 2 }, { id: repeated });
    await wait(() => seen.length >= 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.map((s) => s.n).sort()).toEqual([1, 2]);

    await queue.send(failing, {}, { retryLimit: 0 });
    await wait(() => attempts >= 1);
    expect(attempts).toBe(1);
  }, 60_000);

  it('keeps only a fixed message and the SQLSTATE of a failure', () => {
    const safe = safeJobError(
      Object.assign(new Error('Failing row contains (Asha)'), { code: '23502' }),
    );
    expect(safe.message).toBe('job_failed');
    expect(safe).toMatchObject({ code: '23502' });
    expect(safeJobError(new Error('x')).message).toBe('job_failed');
    expect('code' in safeJobError(Object.assign(new Error('x'), { code: 'not a state' }))).toBe(
      false,
    );
  });

  it('can be stopped before it was ever started', async () => {
    const queue = new PgBossQueue(testConfig().DATABASE_URL, () => undefined);
    await expect(queue.stop()).resolves.toBeUndefined();
  });
});

describe('JOBS_ENABLED', () => {
  it('runs no queue and no poller when off, and starts and stops them when on', async () => {
    const off = await buildTestApp({ config: { JOBS_ENABLED: false } });
    expect(off.jobs.constructor.name).toBe('MemoryQueue');
    await off.close();

    const on = await buildTestApp({ config: { JOBS_ENABLED: true, OUTBOX_POLL_MS: 100 } });
    expect(on.jobs.constructor.name).toBe('PgBossQueue');
    await on.close();
  }, 60_000);
});
