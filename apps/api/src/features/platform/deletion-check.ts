import type pg from 'pg';

export interface DeletionCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * Checks the production login of the hospital deletion job (#1034) over a connection made with
 * `DELETION_DATABASE_URL`: not a superuser, a member of `mediflow_deletion` and no other role,
 * PostgreSQL 15 or newer (the role's grant on `session_replication_role` needs it). Reads only.
 */
export async function checkDeletionLogin(
  client: Pick<pg.Pool, 'query'>,
): Promise<DeletionCheckResult> {
  const problems: string[] = [];
  const { rows } = await client.query<{
    is_super: boolean;
    version_num: number;
    roles: string[];
    login: string;
  }>(
    `SELECT r.rolsuper AS is_super,
            current_setting('server_version_num')::int AS version_num,
            r.rolname AS login,
            COALESCE((SELECT array_agg(g.rolname ORDER BY g.rolname)
                        FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                       WHERE m.member = r.oid), '{}') AS roles
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row) return { ok: false, problems: ['the login is not found in pg_roles'] };
  if (row.is_super) problems.push('the login is a superuser');
  if (row.version_num < 150000) problems.push('PostgreSQL 15 or newer is required');
  if (!row.roles.includes('mediflow_deletion')) {
    problems.push('the login is not a member of mediflow_deletion');
  }
  const others = row.roles.filter((name) => name !== 'mediflow_deletion');
  if (others.length > 0) problems.push('the login is a member of other roles');
  return { ok: problems.length === 0, problems };
}
