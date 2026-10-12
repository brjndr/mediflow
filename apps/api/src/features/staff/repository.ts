import type pg from 'pg';
import type { StaffStatus } from './schemas.js';

/**
 * The staff SQL. Every statement runs on the request's own transaction under the app role, so
 * row-level security limits it to the active hospital: its memberships, the names and addresses
 * of its own members, its invitations and the sessions bound to it (migration 0015).
 */

export interface PersonRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role_id: string;
  role_name: string;
  status: StaffStatus;
  /** The name as the database lower-cases it, which is what the list is ordered by. */
  name_lower: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the next page starts: after this person, in name order. A name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: PersonRow): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    return n.length <= 200 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

/** The hospital's members of one status, or its open invitations, as one shape. */
const PEOPLE: Record<StaffStatus, string> = {
  active: `select m.user_id as id, m.tenant_id, u.name, u.email, m.role_id, r.name as role_name,
                  'active' as status
           from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
           where m.status = 'active'`,
  deactivated: `select m.user_id as id, m.tenant_id, u.name, u.email, m.role_id,
                       r.name as role_name, 'deactivated' as status
                from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
                where m.status = 'suspended'`,
  invited: `select i.id, i.tenant_id, i.name, i.email, i.role_id, r.name as role_name,
                   'invited' as status
            from invites i join roles r on r.id = i.role_id
            where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
};

export interface PeopleList {
  rows: PersonRow[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * One page of people, by name. `q` is matched against the name and the address. Null for a bad
 * cursor. The ordering lower-cases in the query: a hospital's staff is hundreds of rows, found
 * through the tenant index, so there is nothing for a stored column to speed up.
 */
export async function listPeople(
  client: pg.ClientBase,
  { status, q, cursor, limit }: { status: StaffStatus; q: string; cursor?: string; limit: number },
): Promise<PeopleList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  // The database lower-cases both sides: its idea of a letter's lower case is not JavaScript's.
  const filtered = `select p.*, lower(p.name) as name_lower from (${PEOPLE[status]}) p
                    where ($1 = '' or position(lower($1) in lower(p.name || ' ' || p.email)) > 0)`;
  const { rows } = await client.query<PersonRow>(
    `${filtered} and ($2::text is null or (lower(p.name), p.id) > ($2, $3::uuid))
     order by lower(p.name), p.id
     limit $4`,
    [q, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: PeopleList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from (${filtered}) c`,
      [q],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

export interface Grant {
  permission: string;
  scope: string;
}

/** What each role of the hospital holds, by role id. A role with nothing has an empty list. */
export async function roleGrants(
  client: pg.ClientBase,
): Promise<Map<string, { name: string; grants: Grant[] }>> {
  const { rows } = await client.query<{ id: string; name: string; grants: Grant[] }>(
    `select r.id, r.name,
            coalesce((select json_agg(json_build_object('permission', p.permission, 'scope', p.scope))
                      from role_permissions p where p.role_id = r.id), '[]'::json) as grants
     from roles r order by lower(r.name), r.id`,
  );
  return new Map(rows.map((row) => [row.id, { name: row.name, grants: row.grants }]));
}

export interface MemberRow {
  user_id: string;
  tenant_id: string;
  name: string;
  email: string;
  role_id: string;
  role_name: string;
  status: 'active' | 'suspended';
}

/**
 * Locks, in one fixed order, the memberships whose role may manage staff, and returns their user
 * ids. Taken before a member is deactivated: whoever gets the locks first decides, and the other
 * request then counts what is really left. The fixed order keeps two such requests from waiting
 * on each other.
 */
export async function lockStaffManagers(
  client: pg.ClientBase,
  permission: string,
): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    `select m.user_id from memberships m
     where m.status = 'active'
       and exists (select from role_permissions p
                   where p.role_id = m.role_id and p.permission = $1)
     order by m.user_id
     for update of m`,
    [permission],
  );
  return rows.map((row) => row.user_id);
}

/** A member of this hospital, locked until the transaction ends, or null when there is none. */
export async function lockMember(client: pg.ClientBase, userId: string): Promise<MemberRow | null> {
  if (!UUID.test(userId)) return null;
  const { rows } = await client.query<MemberRow>(
    `select m.user_id, m.tenant_id, u.name, u.email, m.role_id, r.name as role_name, m.status
     from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
     where m.user_id = $1
     for update of m`,
    [userId],
  );
  return rows[0] ?? null;
}

/** False when the membership already had that status: nothing was written. */
export async function setMemberStatus(
  client: pg.ClientBase,
  userId: string,
  status: 'active' | 'suspended',
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update memberships set status = $2, updated_at = now()
     where user_id = $1 and status <> $2`,
    [userId, status],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Ends the sessions a person has at this hospital, except one to keep (the caller's own, when
 * they sign themselves out everywhere else). Returns how many were ended.
 */
export async function revokeSessionsHere(
  client: pg.ClientBase,
  userId: string,
  keepSessionId?: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `update sessions set revoked_at = now(), revoke_reason = 'admin'
     where user_id = $1 and revoked_at is null and id is distinct from $2::uuid`,
    [userId, keepSessionId && UUID.test(keepSessionId) ? keepSessionId : null],
  );
  return rowCount ?? 0;
}

/** Withdraws the open invitations a person sent: nobody joins on the word of someone who left. */
export async function revokeInvitesSentBy(client: pg.ClientBase, userId: string): Promise<number> {
  const { rowCount } = await client.query(
    `update invites set revoked_at = now()
     where invited_by = $1 and accepted_at is null and revoked_at is null`,
    [userId],
  );
  return rowCount ?? 0;
}

/** An open invitation of this hospital, locked, or null. */
export async function lockOpenInvite(
  client: pg.ClientBase,
  inviteId: string,
): Promise<{ id: string; role_id: string } | null> {
  if (!UUID.test(inviteId)) return null;
  const { rows } = await client.query<{ id: string; role_id: string }>(
    `select id, role_id from invites
     where id = $1 and accepted_at is null and revoked_at is null
     for update`,
    [inviteId],
  );
  return rows[0] ?? null;
}

export async function revokeInvite(client: pg.ClientBase, inviteId: string): Promise<void> {
  await client.query('update invites set revoked_at = now() where id = $1', [inviteId]);
}
