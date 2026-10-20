import type pg from 'pg';

/**
 * The doctors SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital: its doctors, their hours, its
 * departments, its memberships and the names of its own members.
 */

export interface DoctorRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  /** The name as the database lower-cases it, which is what the list is ordered by. */
  name_lower: string;
  department_id: string;
  department_name: string;
  specialization: string;
  registration_number: string | null;
  qualifications: string | null;
  registration_council: string | null;
  consultation_minutes: number;
  /** Practising here now: the profile is active and so is the person's membership. */
  active: boolean;
  /** What the profile itself says, whatever became of the membership. */
  profile_active: boolean;
  version: number;
  hours_version: number;
}

// A doctor whose membership the hospital has deactivated is not practising here, whatever the
// profile says: scheduling must not offer someone who cannot sign in. Reactivating the member
// brings the doctor back as they were.
const DOCTORS = `select d.id, d.tenant_id, d.user_id, u.name, lower(u.name) as name_lower,
                        d.department_id, p.name as department_name, d.specialization,
                        d.registration_number, d.qualifications, d.registration_council,
                        d.consultation_minutes, (d.active and m.status = 'active') as active,
                        d.active as profile_active, d.version, d.hours_version
                 from doctors d
                 join memberships m on m.user_id = d.user_id
                 join users u on u.id = d.user_id
                 join departments p on p.id = d.department_id`;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the next page starts: after this row, in name order. A name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (name: string, id: string): string =>
  Buffer.from(JSON.stringify({ n: name, i: id } satisfies Cursor)).toString('base64url');

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    // Twice a name's limit: that limit counts characters, this counts UTF-16 units.
    return n.length <= 400 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

export interface Page<Row> {
  rows: Row[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * Runs a list: `source` is a select with `name_lower` and `id` columns that uses parameters up
 * to `values.length`. The page and, for a first page, the count come from the same source.
 * Null for a bad cursor.
 */
async function paged<Row extends { name_lower: string }>(
  client: pg.ClientBase,
  source: string,
  values: unknown[],
  idOf: (row: Row) => string,
  { cursor, limit }: { cursor?: string; limit: number },
): Promise<Page<Row> | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const n = values.length;
  const { rows } = await client.query<Row & { id: string }>(
    `select * from (${source}) s
     where ($${n + 1}::text is null or (s.name_lower, s.id) > ($${n + 1}, $${n + 2}::uuid))
     order by s.name_lower, s.id
     limit $${n + 3}`,
    [...values, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: Page<Row> = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.name_lower, idOf(last)) : null,
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

export interface DoctorFilters {
  q: string;
  /** A department id, or null for every department. */
  departmentId: string | null;
  active: boolean;
}

/** One page of the hospital's doctors, by name. `q` matches the name or the specialization. */
export function listDoctors(
  client: pg.ClientBase,
  { q, departmentId, active }: DoctorFilters,
  paging: { cursor?: string; limit: number },
): Promise<Page<DoctorRow> | null> {
  // The database lower-cases both sides: its idea of a letter's lower case is not JavaScript's.
  const source = `${DOCTORS}
    where (d.active and m.status = 'active') = $1
      and ($2::uuid is null or d.department_id = $2)
      and ($3 = '' or position(lower($3) in lower(u.name || ' ' || d.specialization)) > 0)`;
  return paged<DoctorRow>(client, source, [active, departmentId, q], (row) => row.id, paging);
}

export async function findDoctor(client: pg.ClientBase, id: string): Promise<DoctorRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DoctorRow>(`${DOCTORS} where d.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The doctor, locked until the transaction ends, or null when this hospital has none such. */
export async function lockDoctor(client: pg.ClientBase, id: string): Promise<DoctorRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<DoctorRow>(`${DOCTORS} where d.id = $1 for update of d`, [
    id,
  ]);
  return rows[0] ?? null;
}

export interface CandidateRow {
  id: string;
  name: string;
  name_lower: string;
  email: string;
}

/** Active members of the hospital who have no doctor profile there, by name. */
export function listCandidates(
  client: pg.ClientBase,
  q: string,
  paging: { cursor?: string; limit: number },
): Promise<Page<CandidateRow> | null> {
  const source = `select m.user_id as id, u.name, lower(u.name) as name_lower, u.email
    from memberships m join users u on u.id = m.user_id
    where m.status = 'active'
      and not exists (select from doctors d where d.user_id = m.user_id)
      and ($1 = '' or position(lower($1) in lower(u.name || ' ' || u.email)) > 0)`;
  return paged<CandidateRow>(client, source, [q], (row) => row.id, paging);
}

/** Whether someone is an active member of this hospital. */
export async function isActiveMember(client: pg.ClientBase, userId: string): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const { rowCount } = await client.query(
    "select 1 from memberships where user_id = $1 and status = 'active'",
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/** A department of this hospital: whether it is archived, or null when there is none such. */
export async function departmentState(
  client: pg.ClientBase,
  id: string,
): Promise<{ archived: boolean } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ archived: boolean }>(
    'select archived from departments where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** What Postgres said, when it refused a statement for a rule of the schema. */
export function violation(error: unknown): { code: string; constraint?: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string') return null;
  return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
}

export interface ProfileFields {
  departmentId: string;
  specialization: string;
  registrationNumber: string | null;
  qualifications: string | null;
  registrationCouncil: string | null;
  consultationMinutes: number;
  active: boolean;
}

export async function insertDoctor(
  client: pg.ClientBase,
  userId: string,
  fields: Omit<ProfileFields, 'active'>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into doctors (tenant_id, user_id, department_id, specialization, registration_number,
                          qualifications, registration_council, consultation_minutes)
     values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      userId,
      fields.departmentId,
      fields.specialization,
      fields.registrationNumber,
      fields.qualifications,
      fields.registrationCouncil,
      fields.consultationMinutes,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('doctor was not created');
  return id;
}

export async function updateDoctor(
  client: pg.ClientBase,
  id: string,
  fields: ProfileFields,
): Promise<void> {
  await client.query(
    `update doctors
     set department_id = $2, specialization = $3, registration_number = $4,
         qualifications = $5, registration_council = $6, consultation_minutes = $7, active = $8
     where id = $1`,
    [
      id,
      fields.departmentId,
      fields.specialization,
      fields.registrationNumber,
      fields.qualifications,
      fields.registrationCouncil,
      fields.consultationMinutes,
      fields.active,
    ],
  );
}

export interface HoursRow {
  /** 1 is Monday. */
  day: number;
  start_minute: number;
  end_minute: number;
}

export async function hoursOf(client: pg.ClientBase, doctorId: string): Promise<HoursRow[]> {
  const { rows } = await client.query<HoursRow>(
    `select day, start_minute, end_minute from doctor_hours
     where doctor_id = $1 order by day, start_minute`,
    [doctorId],
  );
  return rows;
}

/** Replaces a doctor's hours and moves their version on. */
export async function replaceHours(
  client: pg.ClientBase,
  doctorId: string,
  hours: HoursRow[],
): Promise<void> {
  await client.query('delete from doctor_hours where doctor_id = $1', [doctorId]);
  if (hours.length > 0) {
    await client.query(
      `insert into doctor_hours (tenant_id, doctor_id, day, start_minute, end_minute)
       select app_tenant_id(), $1, day, start_minute, end_minute
       from unnest($2::smallint[], $3::smallint[], $4::smallint[])
            as h (day, start_minute, end_minute)`,
      [
        doctorId,
        hours.map((row) => row.day),
        hours.map((row) => row.start_minute),
        hours.map((row) => row.end_minute),
      ],
    );
  }
  await client.query('update doctors set hours_version = hours_version + 1 where id = $1', [
    doctorId,
  ]);
}

/** What a printed prescription says of who wrote it, besides the name (#397). */
export interface Credentials {
  qualifications: string | null;
  registrationNumber: string | null;
  registrationCouncil: string | null;
}

/**
 * The credentials on the profiles of these doctors, by doctor id, or of these staff members, by
 * user id: whatever the profile's state, so an old record still prints them. Someone with no
 * profile at this hospital is not in the answer.
 */
export async function credentialsOf(
  client: pg.ClientBase,
  key: 'doctor' | 'user',
  ids: readonly string[],
): Promise<Map<string, Credentials>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const { rows } = await client.query<{
    key: string;
    qualifications: string | null;
    registration_number: string | null;
    registration_council: string | null;
  }>(
    `select ${key === 'doctor' ? 'id' : 'user_id'} as key, qualifications, registration_number,
            registration_council
     from doctors
     -- Row-level security already leaves this hospital's rows only. Named too, since one person
     -- has a profile at each hospital they work at, and a caller outside a request's transaction
     -- would otherwise get each of them.
     where tenant_id = app_tenant_id() and ${key === 'doctor' ? 'id' : 'user_id'} = any($1::uuid[])`,
    [wanted],
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        qualifications: row.qualifications,
        registrationNumber: row.registration_number,
        registrationCouncil: row.registration_council,
      },
    ]),
  );
}
