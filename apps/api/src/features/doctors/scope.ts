import type pg from 'pg';
import type { PermissionScope } from '../../core/access/registry.js';

/**
 * What the appointments, clinical and queue modules ask of the doctors table (#391): who
 * practises here, within which scope, and the caller's own profile and department. They reach it
 * through here, not through SQL of their own on `doctors` and `memberships`. (Names printed in
 * their answers still come from a join on the profile, an allowed read: see CLAUDE.md.)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who the caller is and the scope they hold a permission with. */
export interface DoctorScope {
  scope: PermissionScope;
  userId: string;
}

export interface PractisingDoctor {
  id: string;
  department_id: string;
  consultation_minutes: number;
}

/**
 * A doctor who practises here now (the profile is active and so is the membership), within the
 * scope: `own` only the caller's own profile, `department` a doctor of a department the caller's
 * active profile is in. Null for anyone else, of this hospital or another.
 */
export async function practisingDoctor(
  client: pg.ClientBase,
  id: string,
  visibility: DoctorScope = { scope: 'all', userId: '' },
): Promise<PractisingDoctor | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<PractisingDoctor>(
    `select d.id, d.department_id, d.consultation_minutes
     from doctors d join memberships m on m.user_id = d.user_id
     where d.id = $1 and d.active and m.status = 'active'
       and ($2::text = 'all'
            or ($2::text = 'own' and d.user_id::text = $3::text)
            or ($2::text = 'department' and d.department_id in (${activeDepartmentsOf('$3')})))`,
    [id, visibility.scope, visibility.userId],
  );
  return rows[0] ?? null;
}

/** The caller's own active doctor profile here, or null. */
export async function ownDoctorId(client: pg.ClientBase, userId: string): Promise<string | null> {
  if (!UUID.test(userId)) return null;
  const { rows } = await client.query<{ id: string }>(
    'select id from doctors where user_id = $1 and active',
    [userId],
  );
  return rows[0]?.id ?? null;
}

/** The departments of the caller's active doctor profile. */
export async function departmentsOfCaller(
  client: pg.ClientBase,
  userId: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ department_id: string }>(
    'select department_id from doctors where user_id::text = $1 and active',
    [userId],
  );
  return new Set(rows.map((row) => row.department_id));
}

// SQL fragments for a module's own visibility clause. `user` is a SQL expression for the caller's
// user id (a placeholder such as `$3`); the fragments are subqueries to put after `in`.

/** Departments of the user's active doctor profiles. */
export const activeDepartmentsOf = (user: string): string =>
  `select o.department_id from doctors o where o.user_id::text = ${user}::text and o.active`;

/** Ids of the user's active doctor profiles. */
export const activeProfilesOf = (user: string): string =>
  `select o.id from doctors o where o.user_id::text = ${user}::text and o.active`;

/** Ids of the user's doctor profiles, active or not (what a doctor attended stays theirs). */
export const profilesOf = (user: string): string =>
  `select o.id from doctors o where o.user_id::text = ${user}::text`;

/** The department of a doctor profile, from a SQL expression for its id. */
export const departmentOfDoctor = (doctor: string): string =>
  `select o.department_id from doctors o where o.id = ${doctor}`;
