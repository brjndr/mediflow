import type pg from 'pg';
import { insertEvent } from '../../core/outbox/plugin.js';
import { WORKER_ROLE } from '../../core/outbox/dispatcher.js';
import { APP_ROLE } from '../../core/tenancy/plugin.js';

export const EXPIRY_JOB = 'inventory.expiry';
/** A batch with stock is told when it is this many days (or fewer) from its last day of use. */
export const EXPIRING_WITHIN_DAYS = 90;

/** The hospitals that are active and have the inventory module on. */
async function stockKeepers(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const { rows } = await client.query<{ id: string }>(
      `select t.id from tenants t
       join tenant_features f on f.tenant_id = t.id and f.feature = 'inventory' and f.enabled
       where t.status = 'active'`,
    );
    await client.query('commit');
    return rows.map((row) => row.id);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Tells about the batches of one hospital that have stock and have come within
 * `EXPIRING_WITHIN_DAYS` of their last day of use (today at the hospital), once each: the notice
 * row and the `stock.expiring` event (entity: the batch, payload: its item) are written together,
 * and a batch with a notice is skipped, so a repeat of the job or a second instance sends nothing
 * twice. A batch already expired is told too if it was never told (stock found past its date).
 * Runs in the hospital's own transaction under the app role, as a request would. Gives how many
 * batches were told.
 */
export async function announceExpiring(pool: pg.Pool, tenantId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APP_ROLE}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query<{ batch_id: string; drug_id: string }>(
      `with due as (
         select t.id as batch_id, t.drug_id
         from stock_batches t
         where t.expiry_date <= (select (now() at time zone timezone)::date from tenants
                                 where id = app_tenant_id()) + $1::int
           and exists (select 1 from stock_balances b
                       where b.tenant_id = t.tenant_id and b.batch_id = t.id and b.on_hand > 0)
           and not exists (select 1 from stock_expiry_notices n
                           where n.tenant_id = t.tenant_id and n.batch_id = t.id)
         order by t.expiry_date, t.id
         limit 500
       )
       insert into stock_expiry_notices (tenant_id, batch_id, drug_id)
       select app_tenant_id(), batch_id, drug_id from due
       on conflict do nothing
       returning batch_id, drug_id`,
      [EXPIRING_WITHIN_DAYS],
    );
    for (const row of rows) {
      await insertEvent(client, 'stock.expiring', row.batch_id, null, { drugId: row.drug_id });
    }
    await client.query('commit');
    return rows.length;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The daily job: every hospital with inventory on, one transaction each, so one hospital's
 * failure never holds back another's. A failure is thrown after the rest are done, for the queue
 * to retry; what was told stays told.
 */
export async function announceExpiringEverywhere(pool: pg.Pool): Promise<void> {
  let failed = false;
  for (const tenantId of await stockKeepers(pool)) {
    try {
      await announceExpiring(pool, tenantId);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('expiry_scan_failed');
}
