import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { withTenantTransaction } from '../tenancy/transaction.js';
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
  await withTenantTransaction(pool, message.tenantId, (client) =>
    handler(message, drizzle(client, { schema })),
  );
}
