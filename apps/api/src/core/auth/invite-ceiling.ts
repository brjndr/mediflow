import type pg from 'pg';
import { grantsWithin } from '../access/policy.js';
import { insertAuditEntries } from '../audit/plugin.js';
import { withTenantTransaction } from '../tenancy/transaction.js';

/** What a sender must still hold for any invitation of theirs to stand. */
const INVITE = 'staff:invite';

type Grants = { permission: string; scope: string }[];

/** A role's grants as JSON, for the role named by a column of the query below. */
const grantsOfRole = (roleColumn: 'i.role_id' | 'm.role_id') =>
  `coalesce((select json_agg(json_build_object('permission', p.permission, 'scope', p.scope))
             from role_permissions p
             where p.tenant_id = i.tenant_id and p.role_id = ${roleColumn}), '[]'::json)`;

/**
 * Withdraws the open invitations whose sender could no longer send them: no staff:invite, or an
 * invited role holding more than the sender does (#1224). `roleId` limits it to invitations into
 * that role. An invitation whose sender is no member of the hospital (a platform admin's, or one
 * whose sender's account is gone) is left alone. Runs in the hospital's transaction with its
 * role-change lock held, after the change of permissions. The caller audits the ids returned.
 */
export async function withdrawInvitesBeyondSender(
  client: pg.ClientBase,
  roleId: string | null = null,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; wanted: Grants; held: Grants }>(
    `select i.id, ${grantsOfRole('i.role_id')} as wanted,
            case when m.status = 'active' then ${grantsOfRole('m.role_id')}
                 else '[]'::json end as held
     from invites i
     join memberships m on m.tenant_id = i.tenant_id and m.user_id = i.invited_by
     where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
       and ($1::text is null or i.role_id = $1)
     order by i.id
     for update of i`,
    [roleId],
  );
  const beyond = rows
    .filter(
      ({ wanted, held }) =>
        !held.some((grant) => grant.permission === INVITE) || !grantsWithin(wanted, held),
    )
    .map((row) => row.id);
  if (beyond.length > 0) {
    await client.query('update invites set revoked_at = now() where id = any($1::uuid[])', [
      beyond,
    ]);
  }
  return beyond;
}

/**
 * The same at every hospital, for a deploy: new default grants (or a migration) can raise a role
 * that somebody was invited into. One transaction per hospital, as that hospital under row-level
 * security, with its role-change lock, so it is safe while the API serves. It judges what is there
 * now, so a run that failed is made good by the next. Each withdrawal is audited with no actor.
 * `db` is the owner connection, which lists the hospitals. Returns how many were withdrawn.
 */
export async function withdrawInvitesBeyondSenderEverywhere(db: pg.Pool): Promise<number> {
  const { rows } = await db.query<{ tenant_id: string }>(
    `select distinct tenant_id from invites
     where accepted_at is null and revoked_at is null and expires_at > now()`,
  );
  let withdrawn = 0;
  for (const { tenant_id } of rows) {
    withdrawn += await withTenantTransaction(db, tenant_id, async (client) => {
      // The key the roles and staff features take before changing who may do what.
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('roles:' || app_tenant_id()::text, 0))",
      );
      const ids = await withdrawInvitesBeyondSender(client);
      await insertAuditEntries(
        client,
        null,
        'deploy.role-defaults',
        ids.map((id) => ({ action: 'withdraw', entity: 'invite', entityId: id })),
      );
      return ids.length;
    });
  }
  return withdrawn;
}
