import { PgBoss } from 'pg-boss';

export interface SendOptions {
  /** The job id. Sending an id that already exists is a no-op, which makes a send repeatable. */
  id?: string;
}

/**
 * The job queue, behind an interface so Redis (BullMQ) can replace pg-boss in phase 2 as a
 * configuration change. Handlers must be idempotent: a job can be delivered more than once.
 */
export interface JobQueue {
  send(name: string, data: object, options?: SendOptions): Promise<void>;
  /** Registers a worker. May be called before `start`; it takes effect when the queue starts. */
  work<T extends object>(name: string, handler: (data: T) => Promise<void>): void;
  /** Runs `name` on a cron schedule (UTC). */
  schedule(name: string, cron: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What is kept of a job's failure: a fixed message and, for a database error, its SQLSTATE. A
 * queue stores the error of a failed job, and a database error's own text can quote the values of
 * the row it refused (a patient's name and birth date in "Failing row contains (...)").
 */
export function safeJobError(error: unknown): Error {
  const safe = new Error('job_failed');
  safe.name = 'JobFailed';
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    Object.assign(safe, { code });
  }
  return safe;
}

/** pg-boss on the application's Postgres. It installs its own `pgboss` schema when it starts. */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly known = new Set<string>();
  private readonly pending: (() => Promise<void>)[] = [];

  constructor(
    connectionString: string,
    private readonly onError: (error: Error) => void,
  ) {
    this.boss = new PgBoss({ connectionString });
    this.boss.on('error', onError);
  }

  private async ensureQueue(name: string): Promise<void> {
    if (this.known.has(name)) return;
    await this.boss.createQueue(name);
    this.known.add(name);
  }

  private run(task: () => Promise<void>): void {
    if (this.started) task().catch(this.onError);
    else this.pending.push(task);
  }

  async send(name: string, data: object, options: SendOptions = {}): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.send(name, data, options);
  }

  work<T extends object>(name: string, handler: (data: T) => Promise<void>): void {
    this.run(async () => {
      await this.ensureQueue(name);
      await this.boss.work<T>(name, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } catch (error) {
            // Never the error itself: pg-boss keeps it in its own table, outside every hospital.
            throw safeJobError(error);
          }
        }
      });
    });
  }

  schedule(name: string, cron: string): void {
    this.run(async () => {
      await this.ensureQueue(name);
      await this.boss.schedule(name, cron);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    this.started = true;
    const results = await Promise.allSettled(this.pending.splice(0).map((task) => task()));
    for (const result of results) {
      if (result.status === 'rejected') this.onError(result.reason as Error);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.boss.stop({ graceful: true });
  }
}

/**
 * Runs handlers in-process, without a database. For tests and for running without background
 * work. `sent` records every job; `drain` delivers the ones not delivered yet.
 */
export class MemoryQueue implements JobQueue {
  readonly sent: { name: string; data: object; options: SendOptions }[] = [];
  readonly schedules: { name: string; cron: string }[] = [];
  private readonly handlers = new Map<string, (data: object) => Promise<void>>();
  private delivered = 0;

  async send(name: string, data: object, options: SendOptions = {}): Promise<void> {
    // Like the real queue, an id that was already sent is dropped.
    if (options.id && this.sent.some((job) => job.options.id === options.id)) return;
    this.sent.push({ name, data, options });
  }

  work<T extends object>(name: string, handler: (data: T) => Promise<void>): void {
    this.handlers.set(name, handler as (data: object) => Promise<void>);
  }

  schedule(name: string, cron: string): void {
    this.schedules.push({ name, cron });
  }

  /** Delivers every job not delivered yet to its worker. Jobs nobody works on are dropped. */
  async drain(): Promise<void> {
    while (this.delivered < this.sent.length) {
      const job = this.sent[this.delivered++]!;
      await this.handlers.get(job.name)?.(job.data);
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
