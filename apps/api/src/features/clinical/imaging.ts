import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { moveOrderOf } from './lab.js';
import { UUID } from './repository.js';
import type { OrderStatusValue } from './schemas.js';

/** An imaging order as radiology works it. */
export interface ImagingOrder {
  id: string;
  encounterId: string;
  patientId: string;
  serviceId: string;
  status: OrderStatusValue;
}

/**
 * For radiology: an imaging order of the hospital, whatever encounter it is of, since radiology
 * works them all. `forUpdate` locks it until the transaction ends: every change radiology makes
 * starts here, so it takes its turn with the doctor cancelling the order.
 */
export async function imagingOrder(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<ImagingOrder | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{
    id: string;
    encounter_id: string;
    patient_id: string;
    service_id: string;
    status: OrderStatusValue;
  }>(
    `select id, encounter_id, patient_id, service_id, status from orders
     where id = $1 and type = 'imaging' ${forUpdate ? 'for update' : ''}`,
    [id],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        encounterId: row.encounter_id,
        patientId: row.patient_id,
        serviceId: row.service_id,
        status: row.status,
      }
    : null;
}

/**
 * For radiology: moves an imaging order on by one step, with its audit and, on completing,
 * `order.completed` (`imagingOrder` with `forUpdate` locks it first).
 */
export const moveImagingOrder = (
  request: FastifyRequest,
  orderId: string,
  to: 'accepted' | 'in_progress' | 'completed',
): Promise<void> => moveOrderOf(request, 'imaging', orderId, to);
