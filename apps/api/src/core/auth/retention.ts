import type pg from 'pg';
import { WORKER_ROLE } from '../outbox/dispatcher.js';

/**
 * Deletes account events past their retention, in batches; returns how many went. An event is
 * kept for `days` (the platform default, never below the 730 the database also enforces), or for
 * the longest `account_event_settings.retention_days` among the hospitals its user belongs to.
 * Runs as the worker role, the only one the append-only trigger lets delete.
 */
export async function purgeAccountEvents(pool: pg.Pool, days: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    let total = 0;
    for (;;) {
      const { rowCount } = await client.query(
        `delete from account_events where id in (
           select a.id from account_events a
           where a.at < now() - make_interval(days => greatest($1::int, coalesce(
             (select max(s.retention_days) from memberships m
                join account_event_settings s on s.tenant_id = m.tenant_id
              where m.user_id = a.user_id), 0)))
           limit 5000)`,
        [days],
      );
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < 5000) break;
    }
    await client.query('commit');
    return total;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
