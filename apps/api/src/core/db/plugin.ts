import fp from 'fastify-plugin';
import { createDb, type DbHandle } from './client.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The connection pool and the Drizzle client. Tenant routes use the request's transaction. */
    database: DbHandle;
  }
}

/** Opens the pool for the app and closes it when the app shuts down. */
export const dbPlugin = fp(
  async (app) => {
    const handle = createDb(app.config);
    app.decorate('database', handle);
    app.addHook('onClose', () => handle.close());
  },
  { name: 'db' },
);
