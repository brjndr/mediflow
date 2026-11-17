import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Config } from '../config/config.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  /**
   * Where reports read: the read replica when `DATABASE_REPLICA_URL` is set (its own small pool,
   * so a heavy report cannot take connections from requests), otherwise the primary's pool.
   */
  reportPool: pg.Pool;
  /**
   * Where the hospital deletion job writes (#999): its own login when `DELETION_DATABASE_URL` is
   * set, a member of `mediflow_deletion` and nothing else, otherwise the primary's pool.
   */
  deletionPool: pg.Pool;
  db: Database;
  /** True when the database answers a trivial query. Used by the readiness check. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(
  config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'> & {
    DATABASE_REPLICA_URL?: string;
    DELETION_DATABASE_URL?: string;
  },
): DbHandle {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    // Fail a request quickly when the pool is exhausted instead of queueing without bound.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client can error (server restart). Without a listener that would crash the process.
  pool.on('error', () => {});

  const replica = config.DATABASE_REPLICA_URL
    ? new pg.Pool({
        connectionString: config.DATABASE_REPLICA_URL,
        max: Math.max(2, Math.ceil(config.DATABASE_POOL_MAX / 2)),
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      })
    : undefined;
  replica?.on('error', () => {});

  // Two at most: the job deletes one hospital per run, in one transaction.
  const deletion = config.DELETION_DATABASE_URL
    ? new pg.Pool({
        connectionString: config.DELETION_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      })
    : undefined;
  deletion?.on('error', () => {});

  return {
    pool,
    reportPool: replica ?? pool,
    deletionPool: deletion ?? pool,
    db: drizzle(pool, { schema }),
    async ping() {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      await Promise.all([pool.end(), replica?.end(), deletion?.end()]);
    },
  };
}
