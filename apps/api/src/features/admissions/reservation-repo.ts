import type pg from 'pg';

/** The bed reservations SQL (#582). Runs on the request's transaction, so RLS limits it. */

export type ReservationEnd = 'cancelled' | 'fulfilled' | 'expired';

export interface ReservationRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  bed_id: string;
  ward_id: string;
  expires_at: Date;
  note: string | null;
  created_at: Date;
}

const SELECT = `
  select r.id, r.patient_id, p.first_name || ' ' || p.last_name as patient_name,
         p.mrn as patient_mrn, r.bed_id, r.ward_id, r.expires_at, r.note, r.created_at
  from bed_reservations r
  join patients p on p.tenant_id = r.tenant_id and p.id = r.patient_id`;

/** The reservation holding a bed right now (open and not past its time), or null. */
export async function liveReservationOfBed(
  client: pg.ClientBase,
  bedId: string,
): Promise<ReservationRow | null> {
  const { rows } = await client.query<ReservationRow>(
    `${SELECT} where r.bed_id = $1 and r.released_at is null and r.expires_at > now()`,
    [bedId],
  );
  return rows[0] ?? null;
}

/** One reservation by id, open or not past its time only, or null. */
export async function liveReservation(
  client: pg.ClientBase,
  id: string,
): Promise<ReservationRow | null> {
  const { rows } = await client.query<ReservationRow>(
    `${SELECT} where r.id = $1 and r.released_at is null and r.expires_at > now()`,
    [id],
  );
  return rows[0] ?? null;
}

/** Marks the reservations of a bed (or of a patient) that ran out as expired. */
export async function sweepExpired(
  client: pg.ClientBase,
  by: { bedId: string } | { patientId: string },
): Promise<void> {
  const [column, value] = 'bedId' in by ? ['bed_id', by.bedId] : ['patient_id', by.patientId];
  await client.query(
    `update bed_reservations set released_at = now(), release_reason = 'expired'
     where ${column} = $1 and released_at is null and expires_at <= now()`,
    [value],
  );
}

export async function insertReservation(
  client: pg.ClientBase,
  input: {
    patientId: string;
    bedId: string;
    wardId: string;
    expiresAt: string;
    note?: string;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into bed_reservations (tenant_id, patient_id, bed_id, ward_id, expires_at, note, created_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [input.patientId, input.bedId, input.wardId, input.expiresAt, input.note ?? null, userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('reservation was not inserted');
  return id;
}

/** Ends one open reservation; false when it was not open. */
export async function releaseReservation(
  client: pg.ClientBase,
  id: string,
  reason: ReservationEnd,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update bed_reservations set released_at = now(), released_by = $3, release_reason = $2
     where id = $1 and released_at is null`,
    [id, reason, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** The patient has a bed now: their open reservations (any bed) are fulfilled. */
export async function fulfilReservationsOf(
  client: pg.ClientBase,
  patientId: string,
  userId: string,
): Promise<{ bed_id: string; ward_id: string }[]> {
  const { rows } = await client.query<{ bed_id: string; ward_id: string }>(
    `update bed_reservations set released_at = now(), released_by = $2, release_reason = 'fulfilled'
     where patient_id = $1 and released_at is null
     returning bed_id, ward_id`,
    [patientId, userId],
  );
  return rows;
}

/** The bed and ward of a reservation, open or not, and whether it is still open. */
export async function reservationPlace(
  client: pg.ClientBase,
  id: string,
): Promise<{ bed_id: string; ward_id: string; open: boolean } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await client.query<{ bed_id: string; ward_id: string; open: boolean }>(
    'select bed_id, ward_id, released_at is null as open from bed_reservations where id = $1',
    [id],
  );
  return rows[0] ?? null;
}
