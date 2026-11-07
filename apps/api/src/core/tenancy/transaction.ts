import type pg from 'pg';
import { APP_ROLE } from './plugin.js';

export interface TenantTransactionOptions {
  /** Begin the transaction read only (a report). */
  readOnly?: boolean;
  /** Cancel a statement that runs longer than this many milliseconds. */
  statementTimeoutMs?: number;
}

/**
 * Runs `run` as a request of that hospital would: in one transaction under the app role with the
 * hospital set, so row-level security applies to everything it does. Commits when `run` resolves
 * and rolls back when it throws. This is the one way background work (jobs, event subscribers, a
 * stream checking its session again) opens a transaction at a hospital. When the rollback itself
 * fails the connection is in an unknown state: it is destroyed, never returned to the pool. The
 * connection is given back exactly once.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  run: (client: pg.PoolClient) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query(options.readOnly ? 'begin read only' : 'begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    if (options.statementTimeoutMs !== undefined) {
      await client.query("select set_config('statement_timeout', $1, true)", [
        String(options.statementTimeoutMs),
      ]);
    }
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch((failure: unknown) => {
      broken = failure instanceof Error ? failure : new Error('rollback failed');
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
