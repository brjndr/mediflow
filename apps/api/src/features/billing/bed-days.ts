import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../core/db/schema.js';
import { WORKER_ROLE } from '../../core/outbox/dispatcher.js';
import { withTenantTransaction } from '../../core/tenancy/transaction.js';
import { postCharge } from './posting.js';

export const BED_CHARGE_JOB = 'billing.bed_days';
const BATCH = 500;

/**
 * A bed day is a calendar date (the hospital's clock) on which a patient holds a bed whose
 * category has a bed-day service. An assignment is charged from the date it began through the
 * date it ended, except that the date a patient leaves a bed they were already in on an earlier
 * date is not charged (they spent the night before there, not that one); a bed given and left on
 * the same date is charged that one date. A transfer therefore charges the day of the move once,
 * to the bed the patient moved into. One charge for each admission and date: its `source_ref` is
 * `bed:<admission>:<date>`, unique in the ledger, so running the job again, or two instances at
 * once, post nothing twice. A date is priced from the list in effect on that date, so a tariff
 * change in the middle of a stay, or a late run of the job, never moves a day to the wrong price;
 * a transfer to another category bills each stretch at its own bed-day service. An open assignment is charged up to today.
 */
const DUE = `
  select distinct on (c.admission_id, c.day) c.admission_id, c.encounter_id, c.patient_id,
         c.service_id, c.day::text as day
  from (
    select ba.admission_id, a.encounter_id, a.patient_id, ba.service_id, ba.assigned_at,
           d::date as day
    from bed_assignments ba
    join admissions a on a.tenant_id = ba.tenant_id and a.id = ba.admission_id
      and a.status <> 'cancelled'
    join tenants t on t.id = ba.tenant_id
    cross join lateral (
      select (ba.assigned_at at time zone t.timezone)::date as d0,
             (coalesce(ba.released_at, coalesce($3::timestamptz, now())) at time zone t.timezone)::date as d1
    ) r
    cross join lateral generate_series(
      r.d0::timestamp,
      (case when ba.released_at is not null and r.d1 > r.d0 then r.d1 - 1 else r.d1 end)::timestamp,
      interval '1 day'
    ) d
    where ba.service_id is not null and ($1::uuid is null or ba.admission_id = $1)
  ) c
  where not exists (
    select 1 from charges ch where ch.source_ref = 'bed:' || c.admission_id || ':' || c.day::text
  )
  order by c.admission_id, c.day, c.assigned_at
  limit $2`;

export interface DueBedDay {
  admission_id: string;
  encounter_id: string;
  patient_id: string;
  service_id: string;
  day: string;
}

/** The bed days not yet in the ledger, of one admission or of the whole hospital. */
export async function dueBedDays(
  client: pg.ClientBase,
  admissionId: string | null,
  limit = BATCH,
  asOf: Date | null = null,
): Promise<DueBedDay[]> {
  const { rows } = await client.query<DueBedDay>(DUE, [admissionId, limit, asOf]);
  return rows;
}

/**
 * Posts the bed days due in one hospital, in its own transaction as a request would. Gives how
 * many charges were posted.
 */
export async function postBedDays(
  pool: pg.Pool,
  tenantId: string,
  asOf: Date | null = null,
): Promise<number> {
  let total = 0;
  for (;;) {
    const posted = await withTenantTransaction(pool, tenantId, async (client) => {
      const due = await dueBedDays(client, null, BATCH, asOf);
      const tx = drizzle(client, { schema });
      let count = 0;
      for (const day of due) {
        const id = await postCharge(tx, {
          encounterId: day.encounter_id,
          patientId: day.patient_id,
          serviceId: day.service_id,
          source: 'bed',
          sourceRef: `bed:${day.admission_id}:${day.day}`,
          description: '',
          quantity: 1,
          unitPriceMinor: 0,
          flag: null,
          priceDate: day.day,
        });
        if (id !== null) count += 1;
      }
      return { count, seen: due.length };
    });
    total += posted.count;
    // A full batch may leave more; a batch where nothing posted would repeat itself.
    if (posted.seen < BATCH || posted.count === 0) return total;
  }
}

async function hospitals(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${WORKER_ROLE}`);
    const { rows } = await client.query<{ id: string }>(
      `select t.id from tenants t
       where t.status = 'active'
         and exists (select 1 from tenant_features f
           where f.tenant_id = t.id and f.feature = 'billing' and f.enabled)
         and exists (select 1 from tenant_features f
           where f.tenant_id = t.id and f.feature = 'admissions' and f.enabled)`,
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
 * The daily job: every hospital with billing and admissions on, one transaction each, so one
 * hospital's failure never holds back another's. A failure is thrown after the rest are done, for
 * the queue to retry. It runs every hour because hospitals keep different clocks; the charge of a
 * date already posted makes the repeats do nothing.
 */
export async function postBedDaysEverywhere(pool: pg.Pool): Promise<void> {
  let failed = false;
  for (const tenantId of await hospitals(pool)) {
    try {
      await postBedDays(pool, tenantId);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('bed_days_failed');
}
