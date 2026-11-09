import type pg from 'pg';
import { endEncounter, hasDrafts, hasRecords } from './repository.js';

/**
 * What the admission module asks of the encounters (BE-23): an admission has its own inpatient
 * encounter, opened with it and closed with the discharge. The admission module never writes the
 * encounters table.
 */

/** Opens the inpatient encounter of an admission and answers its id. */
export async function openInpatientEncounter(
  client: pg.ClientBase,
  input: { patientId: string; doctorId: string; departmentId: string },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into encounters (tenant_id, patient_id, type, attending_doctor_id, department_id,
                             opened_by)
     values (app_tenant_id(), $1, 'ipd', $2, $3, $4)
     returning id`,
    [input.patientId, input.doctorId, input.departmentId, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('encounter was not inserted');
  return id;
}

/**
 * Closes an inpatient encounter at discharge. 'unsigned_notes' while any note of it is a draft,
 * 'not_open' when it already ended; nothing changes then.
 */
export async function closeInpatientEncounter(
  client: pg.ClientBase,
  id: string,
  userId: string,
): Promise<'closed' | 'unsigned_notes' | 'not_open'> {
  const { rows } = await client.query<{ status: string }>(
    "select status from encounters where id = $1 and type = 'ipd' for update",
    [id],
  );
  if (rows[0]?.status !== 'open') return 'not_open';
  if (await hasDrafts(client, id)) return 'unsigned_notes';
  await endEncounter(client, id, 'closed', userId, null);
  return 'closed';
}

/**
 * Cancels the inpatient encounter of an admission made by mistake (#573). 'unsigned_notes' while
 * a note is a draft, 'has_records' when anything is on the record (close it by discharging
 * instead), 'not_open' when it already ended; nothing changes then.
 */
export async function cancelInpatientEncounter(
  client: pg.ClientBase,
  id: string,
  userId: string,
  reason: string,
): Promise<'cancelled' | 'unsigned_notes' | 'has_records' | 'not_open'> {
  const { rows } = await client.query<{ status: string }>(
    "select status from encounters where id = $1 and type = 'ipd' for update",
    [id],
  );
  if (rows[0]?.status !== 'open') return 'not_open';
  if (await hasDrafts(client, id)) return 'unsigned_notes';
  if (await hasRecords(client, id)) return 'has_records';
  await endEncounter(client, id, 'cancelled', userId, reason);
  return 'cancelled';
}
