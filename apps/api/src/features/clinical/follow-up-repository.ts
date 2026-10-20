import type pg from 'pg';
import {
  decodeCursor,
  empty,
  paged,
  UUID,
  visible,
  type Page,
  type Visibility,
} from './repository.js';
import type { FollowUpStateValue } from './schemas.js';

/**
 * Follow-ups (#88): the SQL, on the request's transaction under the app role. A follow-up is seen
 * within the scope of its encounter, as every child of an encounter is. Its state is read from
 * the appointment it was booked as, never stored.
 */

export interface FollowUpRow {
  id: string;
  tenant_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  doctor_id: string;
  doctor_name: string;
  due_on: string;
  note: string | null;
  state: FollowUpStateValue;
  appointment_id: string | null;
  appointment_starts_at: Date | null;
  created_at: Date;
  created_by_name: string;
  booked_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  version: number;
}

const STATE = `(case when f.cancelled_at is not null then 'cancelled'
                     when a.status = 'scheduled' then 'booked'
                     when a.status = 'completed' then 'attended'
                     else 'due' end)`;

// `e` and `d` (the encounter and its attending doctor) are what `visible` reads.
const FOLLOW_UPS = `select f.id, f.tenant_id, f.encounter_id, f.patient_id,
                           p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
                           f.doctor_id, coalesce(fu.name, '') as doctor_name,
                           f.due_on::text as due_on, f.note, ${STATE} as state,
                           f.appointment_id, a.starts_at as appointment_starts_at,
                           f.created_at, coalesce(cu.name, '') as created_by_name, f.booked_at,
                           f.cancelled_at, f.cancel_reason, f.version
                    from follow_ups f
                    join encounters e on e.id = f.encounter_id
                    join patients p on p.id = f.patient_id
                    join doctors fd on fd.id = f.doctor_id
                    left join users fu on fu.id = fd.user_id
                    left join doctors d on d.id = e.attending_doctor_id
                    left join appointments a on a.id = f.appointment_id
                    left join users cu on cu.id = f.created_by`;

export interface FollowUpFilters {
  encounterId?: string;
  state?: FollowUpStateValue;
  dueFrom?: string;
  dueTo?: string;
  doctorId?: string;
  cursor?: string;
  limit: number;
}

/**
 * The follow-ups the caller may see, the soonest due first: of one encounter, or the hospital's
 * due list. Null for a bad cursor.
 */
export async function listFollowUps(
  client: pg.ClientBase,
  filters: FollowUpFilters,
  visibility: Visibility,
): Promise<Page<FollowUpRow> | null> {
  // An id that is not one matches nothing, as another hospital's does.
  for (const id of [filters.encounterId, filters.doctorId]) {
    if (id !== undefined && !UUID.test(id)) {
      return filters.cursor === undefined || decodeCursor(filters.cursor)
        ? empty(filters.cursor)
        : null;
    }
  }
  return paged<FollowUpRow>(
    client,
    {
      sql: `${FOLLOW_UPS}
            where ($1::uuid is null or f.encounter_id = $1)
              and ${filters.state === undefined ? 'true' : IN_STATE[filters.state]}
              and ($2::date is null or f.due_on >= $2)
              and ($3::date is null or f.due_on <= $3)
              and ($4::uuid is null or f.doctor_id = $4)
              and ${visible('$5', '$6')}`,
      values: [
        filters.encounterId ?? null,
        filters.dueFrom ?? null,
        filters.dueTo ?? null,
        filters.doctorId ?? null,
        visibility.scope,
        visibility.userId,
      ],
      // The day as an instant (a stored column), so the index orders the rows and the module's
      // cursor carries it.
      at: 'f.due_at',
      id: 'f.id',
      newestFirst: false,
      // A whole hospital's follow-ups are not counted on every first page: only one encounter's
      // or one doctor's.
      count: filters.encounterId !== undefined || filters.doctorId !== undefined,
    },
    filters.cursor,
    filters.limit,
  );
}

/**
 * Each state as plain predicates, the same as `STATE` reads them, so the planner can use the
 * due list's partial index (`cancelled_at is null`). Fixed text, never a value from the request.
 */
const IN_STATE: Record<FollowUpStateValue, string> = {
  due: "(f.cancelled_at is null and (a.id is null or a.status in ('cancelled', 'no_show')))",
  booked: "(f.cancelled_at is null and a.status = 'scheduled')",
  attended: "(f.cancelled_at is null and a.status = 'completed')",
  cancelled: '(f.cancelled_at is not null)',
};

/** One follow-up the caller may see, or null. `forUpdate` locks it. */
export async function findFollowUp(
  client: pg.ClientBase,
  id: string,
  visibility: Visibility,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<FollowUpRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<FollowUpRow>(
    `${FOLLOW_UPS} where f.id = $1 and ${visible('$2', '$3')}${forUpdate ? ' for update of f' : ''}`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

/** Whether `day` is from today to `daysAhead` days ahead, at the hospital. */
export async function dayWithin(
  client: pg.ClientBase,
  day: string,
  daysAhead: number,
): Promise<boolean> {
  const { rows } = await client.query<{ within: boolean }>(
    `select $1::date between (now() at time zone timezone)::date
                         and (now() at time zone timezone)::date + $2::int as within
     from tenants where id = app_tenant_id()`,
    [day, daysAhead],
  );
  return rows[0]?.within ?? false;
}

export async function insertFollowUp(
  client: pg.ClientBase,
  followUp: {
    encounterId: string;
    patientId: string;
    doctorId: string;
    dueOn: string;
    note: string | null;
  },
  userId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into follow_ups (tenant_id, encounter_id, patient_id, doctor_id, due_on, note, created_by)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
     returning id`,
    [
      followUp.encounterId,
      followUp.patientId,
      followUp.doctorId,
      followUp.dueOn,
      followUp.note,
      userId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('follow-up was not inserted');
  return id;
}

export async function setFollowUpAppointment(
  client: pg.ClientBase,
  id: string,
  appointmentId: string,
  userId: string,
): Promise<void> {
  await client.query(
    'update follow_ups set appointment_id = $2, booked_at = now(), booked_by = $3 where id = $1',
    [id, appointmentId, userId],
  );
}

export async function cancelFollowUp(
  client: pg.ClientBase,
  id: string,
  reason: string,
  userId: string,
): Promise<void> {
  await client.query(
    `update follow_ups set cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
     where id = $1`,
    [id, userId, reason],
  );
}
