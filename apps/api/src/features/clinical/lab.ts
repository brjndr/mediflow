import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { orderEvent, userIdOf } from './http.js';
import { findOrder, setOrderStatus, UUID } from './repository.js';
import type { OrderStatusValue } from './schemas.js';

/** A lab order as the laboratory works it. */
export interface LabOrder {
  id: string;
  encounterId: string;
  patientId: string;
  labTestId: string;
  status: OrderStatusValue;
}

/**
 * For the laboratory: a lab order of the hospital, whatever encounter it is of, since the
 * laboratory works them all. `forUpdate` locks it until the transaction ends: every change the
 * laboratory makes starts here, so it takes its turn with the doctor cancelling the order.
 */
export async function labOrder(
  client: pg.ClientBase,
  id: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<LabOrder | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{
    id: string;
    encounter_id: string;
    patient_id: string;
    lab_test_id: string;
    status: OrderStatusValue;
  }>(
    `select id, encounter_id, patient_id, lab_test_id, status from orders
     where id = $1 and type = 'lab' ${forUpdate ? 'for update' : ''}`,
    [id],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        encounterId: row.encounter_id,
        patientId: row.patient_id,
        labTestId: row.lab_test_id,
        status: row.status,
      }
    : null;
}

/** The step a fulfilling module moves an order on by, from the status before it. */
const FROM: Record<'accepted' | 'in_progress' | 'completed', OrderStatusValue> = {
  accepted: 'placed',
  in_progress: 'accepted',
  completed: 'in_progress',
};

/**
 * Moves an order of `type` on by one step, as `POST /orders/:id/status` does, with its audit and,
 * on completing, `order.completed`. The order is locked by the caller. A move from any other
 * status is 409 `invalid_transition`.
 */
export async function moveOrderOf(
  request: FastifyRequest,
  type: 'lab' | 'imaging',
  orderId: string,
  to: 'accepted' | 'in_progress' | 'completed',
): Promise<void> {
  const row = await findOrder(request.txClient, orderId);
  if (!row || row.type !== type) throw new HttpError(404, 'order_not_found', 'No such order');
  if (row.status !== FROM[to]) {
    throw new HttpError(409, 'invalid_transition', `A ${row.status} order does not become ${to}`);
  }
  await setOrderStatus(request.txClient, row.id, to, userIdOf(request));
  request.audit('update', 'order', row.id);
  if (to === 'completed') await request.emit('order.completed', row.id, orderEvent(row));
}

/**
 * For the laboratory: moves a lab order on by one step (`labOrder` with `forUpdate` locks it
 * first).
 */
export const moveLabOrder = (
  request: FastifyRequest,
  orderId: string,
  to: 'accepted' | 'in_progress' | 'completed',
): Promise<void> => moveOrderOf(request, 'lab', orderId, to);
