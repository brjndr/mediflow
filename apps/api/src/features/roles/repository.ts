import type pg from 'pg';

export interface Grant {
  permission: string;
  scope: 'all' | 'own' | 'department';
}

export interface RoleRow {
  id: string;
  name: string;
  built_in: boolean;
  updated_at: Date;
  member_count: number;
  permission_count: number;
}

const ROLE_COLUMNS = `r.id, r.name, r.built_in, r.updated_at,
  (select count(*)::int from memberships m where m.role_id = r.id and m.status = 'active') as member_count,
  (select count(*)::int from role_permissions p where p.role_id = r.id) as permission_count`;

/** Rows are the active hospital's own: row-level security limits every query here. */
export async function listRoles(db: pg.ClientBase): Promise<RoleRow[]> {
  const { rows } = await db.query<RoleRow>(
    `select ${ROLE_COLUMNS} from roles r order by r.built_in desc, lower(r.name), r.id`,
  );
  return rows;
}

export async function findRole(
  db: pg.ClientBase,
  id: string,
  lock = false,
): Promise<RoleRow | null> {
  const { rows } = await db.query<RoleRow>(
    `select ${ROLE_COLUMNS} from roles r where r.id = $1 ${lock ? 'for update of r' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function grantsOf(db: pg.ClientBase, id: string): Promise<Grant[]> {
  const { rows } = await db.query<Grant>(
    'select permission, scope from role_permissions where role_id = $1 order by permission',
    [id],
  );
  return rows;
}

/** Serialises role changes within the hospital, so the safeguards see a settled state. */
export async function lockRoleChanges(db: pg.ClientBase): Promise<void> {
  await db.query(
    "select pg_advisory_xact_lock(hashtextextended('roles:' || app_tenant_id()::text, 0))",
  );
}

/**
 * Locks, in user-id order (the order staff deactivation uses too), the active members whose role
 * holds any of these permissions, so a change that would leave the hospital with nobody to
 * manage it and a deactivation are decided one after the other.
 */
export async function lockManagers(db: pg.ClientBase, permissions: readonly string[]) {
  await db.query(
    `select m.user_id from memberships m
     where m.status = 'active'
       and exists (select from role_permissions p
                   where p.role_id = m.role_id and p.permission = any($1::text[]))
     order by m.user_id
     for update of m`,
    [permissions],
  );
}

/** How many active members hold each permission through their role right now. */
export async function holderCounts(
  db: pg.ClientBase,
  permissions: readonly string[],
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ permission: string; holders: number }>(
    `select p.permission, count(distinct m.user_id)::int as holders
     from role_permissions p join memberships m on m.role_id = p.role_id and m.status = 'active'
     where p.permission = any($1::text[])
     group by p.permission`,
    [permissions],
  );
  return new Map(
    permissions.map((id) => [id, rows.find((row) => row.permission === id)?.holders ?? 0]),
  );
}

/** Whether another role already has this id or name (case-insensitive). */
export async function roleTaken(
  db: pg.ClientBase,
  id: string,
  name: string,
  exceptId = '',
): Promise<boolean> {
  const { rowCount } = await db.query(
    'select 1 from roles where (id = $1 or lower(name) = lower($2)) and id <> $3',
    [id, name, exceptId],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertRole(db: pg.ClientBase, id: string, name: string): Promise<void> {
  await db.query('insert into roles (tenant_id, id, name) values (app_tenant_id(), $1, $2)', [
    id,
    name,
  ]);
}

export async function renameRole(db: pg.ClientBase, id: string, name: string): Promise<void> {
  await db.query('update roles set name = $2, updated_at = now() where id = $1', [id, name]);
}

export async function touchRole(db: pg.ClientBase, id: string): Promise<void> {
  await db.query('update roles set updated_at = now() where id = $1', [id]);
}

export async function deleteRole(db: pg.ClientBase, id: string): Promise<void> {
  await db.query('delete from roles where id = $1', [id]);
}

/** Memberships (any status) and invitations naming the role: it cannot go while there are any. */
export async function usesOfRole(db: pg.ClientBase, id: string): Promise<number> {
  const { rows } = await db.query<{ uses: number }>(
    `select (select count(*) from memberships where role_id = $1)::int
          + (select count(*) from invites where role_id = $1)::int as uses`,
    [id],
  );
  return rows[0]?.uses ?? 0;
}

/** Makes the role hold exactly these grants. Only rows that change are written. */
export async function replaceGrants(
  db: pg.ClientBase,
  id: string,
  grants: readonly Grant[],
): Promise<void> {
  const permissions = grants.map((grant) => grant.permission);
  await db.query(
    'delete from role_permissions where role_id = $1 and permission <> all($2::text[])',
    [id, permissions],
  );
  if (grants.length === 0) return;
  await db.query(
    `insert into role_permissions (tenant_id, role_id, permission, scope)
     select app_tenant_id(), $1, g.permission, g.scope
     from unnest($2::text[], $3::text[]) as g (permission, scope)
     on conflict (tenant_id, role_id, permission) do update set scope = excluded.scope
       where role_permissions.scope <> excluded.scope`,
    [id, permissions, grants.map((grant) => grant.scope)],
  );
}
