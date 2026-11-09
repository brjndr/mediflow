import type pg from 'pg';
import { UUID } from './repository.js';
import type { OrderStatusValue } from './schemas.js';

/** A diet order of an encounter, as the ward reads it (BE-24). Instructions are plain text. */
export interface DietOrder {
  id: string;
  status: OrderStatusValue;
  priority: string;
  instructions: string;
  placedAt: Date;
}

/**
 * For nursing: the diet orders of an encounter, newest first, cancelled ones left out. The ward
 * reads them and never places one (`order:create` is the doctor's).
 */
export async function dietOrdersOf(
  client: pg.ClientBase,
  encounterId: string,
): Promise<DietOrder[]> {
  if (!UUID.test(encounterId)) return [];
  const { rows } = await client.query<{
    id: string;
    status: OrderStatusValue;
    priority: string;
    instructions: string;
    placed_at: Date;
  }>(
    `select id, status, priority, instructions, placed_at from orders
     where encounter_id = $1 and type = 'diet' and status <> 'cancelled'
     order by placed_at desc, id desc limit 50`,
    [encounterId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    priority: row.priority,
    instructions: row.instructions,
    placedAt: row.placed_at,
  }));
}
