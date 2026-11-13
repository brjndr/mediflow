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

/**
 * For the kitchen list: the diet each encounter is on now, the newest order that is not cancelled
 * or finished, one for each encounter that has one. A later order replaces an earlier one.
 */
export async function currentDietsOf(
  client: pg.ClientBase,
  encounterIds: string[],
): Promise<Map<string, DietOrder>> {
  const ids = encounterIds.filter((id) => UUID.test(id));
  const diets = new Map<string, DietOrder>();
  if (ids.length === 0) return diets;
  const { rows } = await client.query<{
    id: string;
    encounter_id: string;
    status: OrderStatusValue;
    priority: string;
    instructions: string;
    placed_at: Date;
  }>(
    `select distinct on (encounter_id) id, encounter_id, status, priority, instructions, placed_at
     from orders
     where encounter_id = any($1::uuid[]) and type = 'diet'
       and status in ('placed', 'accepted', 'in_progress')
     order by encounter_id, placed_at desc, id desc`,
    [ids],
  );
  for (const row of rows) {
    diets.set(row.encounter_id, {
      id: row.id,
      status: row.status,
      priority: row.priority,
      instructions: row.instructions,
      placedAt: row.placed_at,
    });
  }
  return diets;
}
