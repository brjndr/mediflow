import type pg from 'pg';

/** The role platform requests run as. Created in migrations/0065. */
export const PLATFORM_ROLE = 'mediflow_platform';

/**
 * Runs platform work in one transaction, as the platform role. That role can reach the hospital's
 * configuration (its row, module flags, roles, invites and head count) and the platform's own
 * audit trail, and has no grant on any table that holds patient, clinical or billing data, so a
 * mistake here cannot read any. No tenant is set: it is not a hospital's request. Commits when
 * `run` resolves and rolls back when it throws.
 */
export async function withPlatformTransaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${PLATFORM_ROLE}`);
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
