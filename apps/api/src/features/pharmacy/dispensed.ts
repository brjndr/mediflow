import type pg from 'pg';

/** For nursing (BE-24): whether the pharmacy has dispensed anything against a medication order. */
export async function orderDispensed(client: pg.ClientBase, orderId: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from dispenses where order_id = $1 limit 1', [
    orderId,
  ]);
  return (rowCount ?? 0) > 0;
}
