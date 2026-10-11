import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { APP_ROLE } from '../tenancy/plugin.js';
import type { DomainEventMessage } from './events.js';

/**
 * Runs a subscriber's handler the way a request would: in one transaction under the app role, with
 * the hospital of the event as the tenant, so row-level security applies to everything the handler
 * does. The transaction commits when the handler returns and rolls back when it throws (the queue
 * then retries).
 */
export async function runAsTenant(
  pool: pg.Pool,
  message: DomainEventMessage,
  handler: (message: DomainEventMessage, tx: Database) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [message.tenantId]);
    await handler(message, drizzle(client, { schema }));
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
