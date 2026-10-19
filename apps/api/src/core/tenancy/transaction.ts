import type pg from 'pg';
import { APP_ROLE } from './plugin.js';

/**
 * Runs `run` as a request of that hospital would: in one transaction under the app role with the
 * hospital set, so row-level security applies to everything it does. Commits when `run` resolves
 * and rolls back when it throws. For work that belongs to a request but outlives its own
 * transaction (an event stream checking its session again).
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await run(client);
    await client.query('commit');
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
      client.release();
    } catch (rollbackError) {
      // The connection is in an unknown state: destroy it instead of returning it to the pool.
      client.release(rollbackError instanceof Error ? rollbackError : true);
    }
    throw error;
  }
}
