import type pg from 'pg';
import { WORKER_ROLE } from '../../core/outbox/dispatcher.js';
import { insertEvent } from '../../core/outbox/plugin.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';

export const BLOOD_EXPIRY_JOB = 'bloodbank.expiry';
/** The actor of a move nobody made: the all-zero id, shown in a unit's history as the system. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const BATCH = 500;

/** The hospitals that are active and have the blood bank on. */
async function bloodBanks(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const { rows } = await client.query<{ id: string }>(
      `select t.id from tenants t
       join tenant_features f on f.tenant_id = t.id and f.feature = 'bloodbank' and f.enabled
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
 * Moves every available or reserved unit of one hospital that is past its date to `expired`,
 * in the hospital's own transaction as a request would: a history row (actor: the system), and
 * a `blood.unit_status_changed` event for each. A unit already moved is no longer selected, so
 * a repeat of the job or a second instance does nothing twice. Gives how many units moved.
 */
export async function expireBloodUnits(pool: pg.Pool, tenantId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const moved = await withTenantTransaction(pool, tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        patient_id: string | null;
        blood_group: string;
        component: string;
      }>(
        `select id, status, patient_id, blood_group, component from blood_units
         where status in ('available', 'reserved') and expires_at <= now()
         order by expires_at, id limit ${BATCH} for update skip locked`,
      );
      for (const unit of rows) {
        await client.query(`update blood_units set status = 'expired' where id = $1`, [unit.id]);
        await client.query(
          `insert into blood_unit_events (blood_unit_id, from_status, to_status, patient_id, reason, actor_id)
           values ($1, $2, 'expired', $3, 'Past its date', $4)`,
          [unit.id, unit.status, unit.patient_id, SYSTEM_ACTOR],
        );
        await insertEvent(client, 'blood.unit_status_changed', unit.id, null, {
          from: unit.status,
          to: 'expired',
          patientId: unit.patient_id,
          bloodGroup: unit.blood_group,
          component: unit.component,
        });
      }
      return rows.length;
    });
    total += moved;
    if (moved < BATCH) return total;
  }
}

/**
 * The job: every hospital with the blood bank on, one transaction each, so one hospital's
 * failure never holds back another's. A failure is thrown after the rest are done, for the
 * queue to retry.
 */
export async function expireBloodUnitsEverywhere(pool: pg.Pool): Promise<void> {
  let failed = false;
  for (const tenantId of await bloodBanks(pool)) {
    try {
      await expireBloodUnits(pool, tenantId);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('blood_expiry_failed');
}
