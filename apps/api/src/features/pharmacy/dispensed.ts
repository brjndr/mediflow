import type pg from 'pg';

/** For nursing (BE-24): whether the pharmacy has dispensed anything against a medication order. */
export async function orderDispensed(client: pg.ClientBase, orderId: string): Promise<boolean> {
  const { rowCount } = await client.query('select 1 from dispenses where order_id = $1 limit 1', [
    orderId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** For nursing: which of these medication orders have anything dispensed against them, in one query. */
export async function dispensedOrders(
  client: pg.ClientBase,
  orderIds: string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const { rows } = await client.query<{ order_id: string }>(
    'select distinct order_id from dispenses where order_id = any($1::uuid[])',
    [orderIds],
  );
  return new Set(rows.map((row) => row.order_id));
}
