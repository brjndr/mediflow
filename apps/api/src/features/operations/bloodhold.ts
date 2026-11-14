import type { FastifyRequest } from 'fastify';
import { userIdOf } from './util.js';

/**
 * Taking blood units out of use on the bank's own account (#585): the sibling units of a severe
 * reaction, and the other units of a donor whose screening was reactive. Each unit goes to
 * `discarded` through the unit's own guard (so a unit already given, discarded or expired is left
 * alone), with a history row, an audit entry and the usual event, in the request's transaction.
 */

/** The states a unit can still be discarded from. */
const HOLDABLE = ['collected', 'testing', 'available', 'reserved', 'issued'];

/** Other units of the same collection as `unitId`, still holdable. */
export async function siblingUnitIds(request: FastifyRequest, unitId: string): Promise<string[]> {
  const { rows } = await request.txClient.query<{ id: string }>(
    `select b.id from blood_units b join blood_units u on u.id = $1
       and u.collection_id is not null and b.collection_id = u.collection_id and b.id <> u.id
     where b.status = any($2::text[]) order by b.id`,
    [unitId, HOLDABLE],
  );
  return rows.map((row) => row.id);
}

/** Other units of the same donor that are not yet screened (collected or testing). */
export async function unscreenedUnitIdsOfDonor(
  request: FastifyRequest,
  donorId: string,
  exceptUnitId: string,
): Promise<string[]> {
  const { rows } = await request.txClient.query<{ id: string }>(
    `select id from blood_units where donor_id = $1 and id <> $2
       and status in ('collected', 'testing') order by id`,
    [donorId, exceptUnitId],
  );
  return rows.map((row) => row.id);
}

/** Discards the units that can still be, with `reason`; returns the ids that were. */
export async function discardUnits(
  request: FastifyRequest,
  unitIds: string[],
  reason: string,
): Promise<string[]> {
  if (unitIds.length === 0) return [];
  const client = request.txClient;
  const actor = userIdOf(request);
  const { rows } = await client.query<{
    id: string;
    status: string;
    blood_group: string;
    component: string;
    patient_id: string | null;
  }>(
    `select id, status, blood_group, component, patient_id from blood_units
     where id = any($1::uuid[]) and status = any($2::text[]) order by id for update`,
    [unitIds, HOLDABLE],
  );
  for (const unit of rows) {
    await client.query("update blood_units set status = 'discarded' where id = $1", [unit.id]);
    await client.query(
      `insert into blood_unit_events (blood_unit_id, from_status, to_status, patient_id, reason, actor_id)
       values ($1, $2, 'discarded', $3, $4, $5)`,
      [unit.id, unit.status, unit.patient_id, reason, actor],
    );
    request.audit('update', 'blood_unit', unit.id);
    await request.emit('blood.unit_status_changed', unit.id, {
      from: unit.status,
      to: 'discarded',
      patientId: unit.patient_id,
      bloodGroup: unit.blood_group,
      component: unit.component,
      encounterId: null,
      serviceId: null,
    });
  }
  return rows.map((unit) => unit.id);
}
