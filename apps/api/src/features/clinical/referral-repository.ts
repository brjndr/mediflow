import type pg from 'pg';
import { paged, UUID, type Page } from './repository.js';

/**
 * Referrals (#88): the SQL, on the request's transaction under the app role. A referral is found
 * by its id, then its encounter within the caller's scope, as every child of an encounter is.
 */

export interface ReferralRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  department_id: string;
  department_name: string;
  doctor_id: string | null;
  doctor_name: string | null;
  urgency: 'routine' | 'urgent';
  reason: string;
  referred_at: Date;
  referred_by_name: string;
  cancelled_at: Date | null;
  cancelled_by_name: string | null;
  cancel_reason: string | null;
}

const REFERRALS = `select r.id, r.tenant_id, r.encounter_id, r.patient_id, r.department_id,
                          dp.name as department_name, r.doctor_id, du.name as doctor_name,
                          r.urgency, r.reason, r.referred_at,
                          coalesce(ru.name, '') as referred_by_name, r.cancelled_at,
                          cu.name as cancelled_by_name, r.cancel_reason
                   from referrals r
                   join departments dp on dp.id = r.department_id
                   left join doctors d on d.id = r.doctor_id
                   left join users du on du.id = d.user_id
                   left join users ru on ru.id = r.referred_by
                   left join users cu on cu.id = r.cancelled_by`;

export async function listReferrals(
  client: pg.ClientBase,
  encounterId: string,
  page: { cursor?: string; limit: number },
): Promise<Page<ReferralRow> | null> {
  return paged<ReferralRow>(
    client,
    {
      sql: `${REFERRALS} where r.encounter_id = $1`,
      values: [encounterId],
      at: 'r.referred_at',
      id: 'r.id',
      newestFirst: false,
    },
    page.cursor,
    page.limit,
  );
}

export async function findReferral(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<ReferralRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<ReferralRow>(
    `${REFERRALS} where r.id = $1 ${forUpdate ? 'for update of r' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** Whether the department is one of the hospital's that is not archived. */
export async function activeDepartment(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query(
    'select 1 from departments where id = $1 and not archived',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertReferral(
  client: pg.ClientBase,
  referral: {
    encounterId: string;
    patientId: string;
    departmentId: string;
    doctorId: string | null;
    urgency: 'routine' | 'urgent';
    reason: string;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into referrals (tenant_id, encounter_id, patient_id, department_id, doctor_id,
                            urgency, reason, referred_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      referral.encounterId,
      referral.patientId,
      referral.departmentId,
      referral.doctorId,
      referral.urgency,
      referral.reason,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('referral was not inserted');
  return id;
}

export async function cancelReferral(
  client: pg.ClientBase,
  id: string,
  reason: string,
  userId: string,
): Promise<void> {
  await client.query(
    `update referrals set cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
     where id = $1`,
    [id, userId, reason],
  );
}
