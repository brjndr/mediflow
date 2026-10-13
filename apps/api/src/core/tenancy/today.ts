import type pg from 'pg';
import { HttpError } from '../http/errors.js';

/**
 * Today's date where the request's hospital is, as YYYY-MM-DD, on the database clock. A calendar
 * date that a rule compares with "today" (the day a price starts) is a date at the hospital, not
 * at the server.
 */
export async function todayAtHospital(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    'select (now() at time zone timezone)::date::text as today from tenants where id = app_tenant_id()',
  );
  const today = rows[0]?.today;
  if (!today) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
  return today;
}
