import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { moveOrderOf } from './lab.js';
import { UUID } from './repository.js';
import type { OrderStatusValue } from './schemas.js';

/** A medication order (a line of a prescription) as the pharmacy dispenses it. */
export interface MedicationOrder {
  id: string;
  encounterId: string;
  patientId: string;
  prescriptionId: string;
  drugId: string;
  /** How much the doctor asked to dispense; null when the prescription does not say. */
  quantity: number | null;
  status: OrderStatusValue;
  version: number;
  /** As prescribed, for the ward's medication chart (BE-24). */
  dose: string;
  route: string;
  frequency: string;
  itemName: string;
  placedAt: Date;
}

/**
 * For the pharmacy: a medication order of the hospital, whatever encounter it is of, since the
 * pharmacy dispenses them all. `forUpdate` locks it until the transaction ends: every dispense
 * starts here, so it takes its turn with another dispense and with the doctor cancelling it.
 */
export async function medicationOrder(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<MedicationOrder | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{
    id: string;
    encounter_id: string;
    patient_id: string;
    prescription_id: string;
    drug_id: string;
    quantity: number | null;
    status: OrderStatusValue;
    version: number;
    dose: string;
    route: string;
    frequency: string;
    item_name: string;
    placed_at: Date;
  }>(
    `select id, encounter_id, patient_id, prescription_id, drug_id, quantity, status, version,
            dose, route, frequency, item_name, placed_at
     from orders where id = $1 and type = 'medication' ${forUpdate ? 'for update' : ''}`,
    [id],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        encounterId: row.encounter_id,
        patientId: row.patient_id,
        prescriptionId: row.prescription_id,
        drugId: row.drug_id,
        quantity: row.quantity,
        status: row.status,
        version: row.version,
        dose: row.dose,
        route: row.route,
        frequency: row.frequency,
        itemName: row.item_name,
        placedAt: row.placed_at,
      }
    : null;
}

/**
 * For the pharmacy: moves a medication order on by one step, with its audit and, on completing,
 * `order.completed` (`medicationOrder` with `forUpdate` locks it first).
 */
export const moveMedicationOrder = (
  request: FastifyRequest,
  orderId: string,
  to: 'accepted' | 'in_progress' | 'completed',
): Promise<void> => moveOrderOf(request, 'medication', orderId, to);

/** A medication order of an encounter, for the ward medication chart (BE-24). */
export type EncounterMedicationOrder = MedicationOrder;

/** The medication orders of an encounter, oldest first, up to `limit` (no more than 200), in one query. */
export async function medicationOrdersOf(
  client: pg.ClientBase,
  encounterId: string,
  limit = 200,
): Promise<EncounterMedicationOrder[]> {
  if (!UUID.test(encounterId)) return [];
  const { rows } = await client.query<{
    id: string;
    encounter_id: string;
    patient_id: string;
    prescription_id: string;
    drug_id: string;
    quantity: number | null;
    status: OrderStatusValue;
    version: number;
    dose: string;
    route: string;
    frequency: string;
    item_name: string;
    placed_at: Date;
  }>(
    `select id, encounter_id, patient_id, prescription_id, drug_id, quantity, status, version,
            dose, route, frequency, item_name, placed_at
     from orders where encounter_id = $1 and type = 'medication'
     order by placed_at, line_number, id limit $2`,
    [encounterId, Math.min(limit, 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    prescriptionId: row.prescription_id,
    drugId: row.drug_id,
    quantity: row.quantity,
    status: row.status,
    version: row.version,
    dose: row.dose,
    route: row.route,
    frequency: row.frequency,
    itemName: row.item_name,
    placedAt: row.placed_at,
  }));
}
