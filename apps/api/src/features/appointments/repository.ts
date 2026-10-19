import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';
import type { AppointmentStatusValue } from './schemas.js';

/**
 * The appointments SQL. Every statement runs on the request's own transaction under the app
 * role, so row-level security limits it to the active hospital: its appointments, patients,
 * doctors, departments and the names of its own members. Days are calendar days at the
 * hospital, turned into instants in SQL with the hospital's own timezone.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far ahead a booking may be, in days after today at the hospital. */
export const BOOKING_DAYS_AHEAD = 90;

export interface AppointmentRow {
  id: string;
  tenant_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  doctor_id: string;
  doctor_name: string;
  department_name: string | null;
  starts_at: Date;
  ends_at: Date;
  status: AppointmentStatusValue;
  version: number;
  reason: string | null;
  cancel_reason: string | null;
  cancel_note: string | null;
}

const APPOINTMENTS = `select a.id, a.tenant_id, a.patient_id,
                             p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
                             a.doctor_id, u.name as doctor_name, dp.name as department_name,
                             a.starts_at, a.ends_at, a.status, a.version,
                             a.reason, a.cancel_reason, a.cancel_note
                      from appointments a
                      join patients p on p.id = a.patient_id
                      join doctors d on d.id = a.doctor_id
                      join users u on u.id = d.user_id
                      left join departments dp on dp.id = d.department_id`;

/** Who may be seen: the scope the caller holds the permission with, and who the caller is. */
export interface Visibility {
  scope: PermissionScope;
  userId: string;
}

// `own` is the appointments of the caller's own doctor profile; `department` those of the
// departments the caller's active profile is in. Someone with no such profile sees nothing.
const visible = (scope: string, user: string) =>
  `(${scope}::text = 'all'
    or (${scope}::text = 'own' and d.user_id::text = ${user}::text)
    or (${scope}::text = 'department' and d.department_id in (
          select o.department_id from doctors o where o.user_id::text = ${user}::text and o.active)))`;

interface Cursor {
  s: string;
  i: string;
}

const encodeCursor = (startsAt: Date, id: string): string =>
  Buffer.from(JSON.stringify({ s: startsAt.toISOString(), i: id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { s, i } = value as Record<string, unknown>;
    if (typeof s !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    return Number.isNaN(Date.parse(s)) ? null : { s, i };
  } catch {
    return null;
  }
}

export interface ListFilters {
  from: string;
  to: string;
  doctorId?: string;
  status?: AppointmentStatusValue;
  cursor?: string;
  limit: number;
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * The appointments that start on the days from `from` to `to` at the hospital, by start then id.
 * Null for a bad cursor.
 */
export async function listAppointments(
  client: pg.ClientBase,
  filters: ListFilters,
  visibility: Visibility,
): Promise<Page<AppointmentRow> | null> {
  const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor);
  if (after === null) return null;
  // A doctor id that is not one matches nothing, as another hospital's does.
  if (filters.doctorId !== undefined && !UUID.test(filters.doctorId)) {
    return { rows: [], nextCursor: null, ...(after === undefined ? { total: 0 } : {}) };
  }
  const source = `${APPOINTMENTS}
    cross join (select timezone from tenants where id = app_tenant_id()) t
    where a.starts_at >= ($1::date)::timestamp at time zone t.timezone
      and a.starts_at < ($2::date + 1)::timestamp at time zone t.timezone
      and ($3::uuid is null or a.doctor_id = $3::uuid)
      and ($4::text is null or a.status = $4)
      and ${visible('$5', '$6')}`;
  const values = [
    filters.from,
    filters.to,
    filters.doctorId ?? null,
    filters.status ?? null,
    visibility.scope,
    visibility.userId,
  ];
  const { rows } = await client.query<AppointmentRow>(
    `${source}
       and ($7::timestamptz is null
            or (a.starts_at >= $7 and (a.starts_at > $7 or a.id > $8::uuid)))
     order by a.starts_at, a.id
     limit $9`,
    [...values, after?.s ?? null, after?.i ?? null, filters.limit + 1],
  );
  const page = rows.slice(0, filters.limit);
  const last = page.at(-1);
  const result: Page<AppointmentRow> = {
    rows: page,
    nextCursor: rows.length > filters.limit && last ? encodeCursor(last.starts_at, last.id) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from (${source}) s`,
      values,
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** One appointment the caller may see, or null. `forUpdate` locks it for a change. */
export async function findAppointment(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<AppointmentRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<AppointmentRow>(
    `${APPOINTMENTS} where a.id = $1 and ${visible('$2', '$3')}${forUpdate ? ' for update of a' : ''}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

export async function patientExists(client: pg.ClientBase, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await client.query('select 1 from patients where id = $1', [id]);
  return rowCount === 1;
}

/**
 * A doctor who practises here now (the profile is active and so is the membership), with the
 * length of one appointment. Null for anyone else, of this hospital or another, and for a doctor
 * outside the scope the caller books or changes with: an appointment is only made, or moved, where
 * the caller could then see it.
 */
export async function practisingDoctor(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility = { scope: 'all', userId: '' },
): Promise<{ id: string; consultation_minutes: number } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ id: string; consultation_minutes: number }>(
    `select d.id, d.consultation_minutes
     from doctors d join memberships m on m.user_id = d.user_id
     where d.id = $1 and d.active and m.status = 'active' and ${visible('$2', '$3')}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

export interface Slot {
  starts_at: Date;
  ends_at: Date;
}

/**
 * A doctor's slots on one day at the hospital: the weekday's working hours cut into the
 * consultation length, those that have not started, within the booking window (today to
 * `BOOKING_DAYS_AHEAD` days ahead). With `free`, a slot that overlaps a scheduled appointment of
 * the doctor is left out.
 */
export async function slotsOn(
  client: pg.ClientBase,
  doctor: { id: string; consultation_minutes: number },
  day: string,
  { free }: { free: boolean },
): Promise<Slot[]> {
  const { rows } = await client.query<Slot>(
    `with t as (
       select timezone, (now() at time zone timezone)::date as today
       from tenants where id = app_tenant_id()
     )
     select s.starts_at, s.starts_at + make_interval(mins => $3) as ends_at
     from t
     cross join doctor_hours h
     cross join lateral generate_series(h.start_minute::int, h.end_minute - $3::int, $3::int) as m(minute)
     cross join lateral (
       select ($2::date + make_interval(mins => m.minute))::timestamp at time zone t.timezone
         as starts_at
     ) s
     where h.doctor_id = $1
       and h.day = extract(isodow from $2::date)
       and $2::date between t.today and t.today + $4::int
       and s.starts_at > now()
       -- On a day the clocks change, a wall time that does not exist, and a slot that would
       -- cross the change, are not slots: start and end must both be the wall times they say.
       and s.starts_at at time zone t.timezone = $2::date + make_interval(mins => m.minute)
       and s.starts_at + make_interval(mins => $3)
         = ($2::date + make_interval(mins => m.minute + $3))::timestamp at time zone t.timezone
       and (not $5 or not exists (
         select 1 from appointments a
         where a.doctor_id = $1 and a.status = 'scheduled'
           and tstzrange(a.starts_at, a.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $3))
       ))
     order by s.starts_at`,
    [doctor.id, day, doctor.consultation_minutes, BOOKING_DAYS_AHEAD, free],
  );
  return rows;
}

/** The calendar day at the hospital that an instant falls on. */
export async function dayAtHospital(client: pg.ClientBase, instant: string): Promise<string> {
  const { rows } = await client.query<{ day: string }>(
    `select ($1::timestamptz at time zone timezone)::date::text as day
     from tenants where id = app_tenant_id()`,
    [instant],
  );
  return rows[0]?.day ?? '';
}

/**
 * The working slot of the doctor that starts at that instant, free or not (the exclusion
 * constraints decide between bookings), or null when there is none: not a slot of the hours, past,
 * or outside the booking window.
 */
export async function slotAt(
  client: pg.ClientBase,
  doctor: { id: string; consultation_minutes: number },
  startsAt: string,
): Promise<Slot | null> {
  const instant = Date.parse(startsAt);
  if (Number.isNaN(instant)) return null;
  const day = await dayAtHospital(client, startsAt);
  const slots = await slotsOn(client, doctor, day, { free: false });
  return slots.find((slot) => slot.starts_at.getTime() === instant) ?? null;
}

export async function insertAppointment(
  client: pg.ClientBase,
  input: { patientId: string; doctorId: string; slot: Slot; reason: string | null },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into appointments (tenant_id, patient_id, doctor_id, starts_at, ends_at, reason, created_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [
      input.patientId,
      input.doctorId,
      input.slot.starts_at,
      input.slot.ends_at,
      input.reason,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('appointment was not inserted');
  return id;
}

export async function moveAppointment(
  client: pg.ClientBase,
  id: string,
  doctorId: string,
  slot: Slot,
): Promise<void> {
  await client.query(
    'update appointments set doctor_id = $2, starts_at = $3, ends_at = $4 where id = $1',
    [id, doctorId, slot.starts_at, slot.ends_at],
  );
}

export async function setStatus(
  client: pg.ClientBase,
  id: string,
  status: Exclude<AppointmentStatusValue, 'scheduled'>,
  cancellation: { reason: string; note: string | null } | null = null,
): Promise<void> {
  await client.query(
    'update appointments set status = $2, cancel_reason = $3, cancel_note = $4 where id = $1',
    [id, status, cancellation?.reason ?? null, cancellation?.note ?? null],
  );
}

/** Whether the clock at the database has passed an instant. */
export async function hasPassed(client: pg.ClientBase, instant: Date): Promise<boolean> {
  const { rows } = await client.query<{ passed: boolean }>(
    'select now() >= $1::timestamptz as passed',
    [instant],
  );
  return rows[0]?.passed ?? false;
}

/** What the queue needs to check a booked patient in: ids, the status and the booked time. */
export interface CheckInAppointment {
  id: string;
  patientId: string;
  doctorId: string;
  status: AppointmentStatusValue;
  startsAt: Date;
  /** Whether it starts on today's calendar day at the hospital. */
  startsToday: boolean;
}

/**
 * One appointment the caller may see, within the scope they read appointments with, for checking
 * its patient in; or null. Exported from `index.ts`, so the queue never reads this table itself.
 */
export async function appointmentForCheckIn(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
): Promise<CheckInAppointment | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{
    id: string;
    patient_id: string;
    doctor_id: string;
    status: AppointmentStatusValue;
    starts_at: Date;
    starts_today: boolean;
  }>(
    `select a.id, a.patient_id, a.doctor_id, a.status, a.starts_at,
            (a.starts_at at time zone tn.timezone)::date = (now() at time zone tn.timezone)::date
              as starts_today
     from appointments a
     join doctors d on d.id = a.doctor_id
     join tenants tn on tn.id = app_tenant_id()
     where a.id = $1 and ${visible('$2', '$3')}`,
    [id, visibility.scope, visibility.userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    status: row.status,
    startsAt: row.starts_at,
    startsToday: row.starts_today,
  };
}
