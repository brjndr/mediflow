import type pg from 'pg';

/** The role authentication runs as. Created in migrations/0004. */
export const AUTH_ROLE = 'mediflow_auth';

export interface AuthTransaction {
  client: pg.PoolClient;
  /**
   * Tells the database which user this transaction is about, once that is established (a
   * verified password or a valid session). Until then the user's hospitals are invisible.
   */
  identify(userId: string): Promise<void>;
}

/**
 * Runs authentication work in one transaction, as the auth role. That role can reach the
 * identity tables and nothing that holds hospital data, so a mistake in this code cannot read a
 * patient record. Commits when `run` resolves and rolls back when it throws.
 */
export async function withAuthTransaction<T>(
  pool: pg.Pool,
  run: (transaction: AuthTransaction) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${AUTH_ROLE}`);
    const result = await run({
      client,
      identify: async (userId) => {
        await client.query("select set_config('app.user_id', $1, true)", [userId]);
      },
    });
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
