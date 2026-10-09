import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Config } from '../config/config.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  db: Database;
  /** True when the database answers a trivial query. Used by the readiness check. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): DbHandle {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    // Fail a request quickly when the pool is exhausted instead of queueing without bound.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client can error (server restart). Without a listener that would crash the process.
  pool.on('error', () => {});

  return {
    pool,
    db: drizzle(pool, { schema }),
    async ping() {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
