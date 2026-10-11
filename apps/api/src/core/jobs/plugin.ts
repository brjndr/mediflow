import fp from 'fastify-plugin';
import { MemoryQueue, PgBossQueue, type JobQueue } from './queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The job queue: pg-boss normally, in-process when `JOBS_ENABLED` is off. */
    jobs: JobQueue;
  }
}

/** Opens the queue with the app and stops it (letting running jobs finish) when the app closes. */
export const jobsPlugin = fp<{ queue?: JobQueue }>(
  async (app, options) => {
    const queue =
      options.queue ??
      (app.config.JOBS_ENABLED
        ? new PgBossQueue(app.config.DATABASE_URL, () => {
            app.log.error({ event: 'job_queue_error' }, 'job queue error');
          })
        : new MemoryQueue());
    app.decorate('jobs', queue);
    // Workers are registered by plugins during startup, so the queue starts once all are loaded.
    app.addHook('onReady', () => queue.start());
    app.addHook('onClose', () => queue.stop());
  },
  { name: 'jobs' },
);
