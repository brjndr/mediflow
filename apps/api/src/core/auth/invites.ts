import type pg from 'pg';
import type { Config } from '../config/config.js';
import type { Notifier } from '../notifier/notifier.js';
import type { AuthTransaction } from './db.js';
import { normalizeEmail } from './login.js';
import { hashPassword, passwordProblem, type PasswordProblem } from './password.js';
import { hashToken, isToken, newToken } from './sessions.js';

type InviteConfig = Pick<Config, 'INVITE_TTL_HOURS'>;

export interface IssuedInvite {
  id: string;
  email: string;
  hospitalName: string;
  /** Goes in the emailed link. Never stored and never logged. */
  token: string;
  expiresInHours: number;
}

/**
 * Invites someone to the active hospital in a role.
 *
 * Unlike the rest of this folder, this runs in the **hospital's** transaction (the app role with
 * the tenant set, i.e. the connection behind `request.tx`), because inviting is something a
 * hospital admin does. The hospital is the transaction's own: it is not a parameter, and
 * row-level security refuses any other. An earlier open invite to the same address is withdrawn,
 * so only the newest link works.
 *
 * Send the email with `sendInvite` after the transaction has committed.
 */
export async function issueInvite(
  client: pg.ClientBase,
  config: InviteConfig,
  input: { email: string; name: string; roleId: string; invitedBy: string | null },
): Promise<IssuedInvite> {
  const email = normalizeEmail(input.email);
  const { token, hash } = newToken();
  await client.query(
    `update invites set revoked_at = now()
     where email = $1 and accepted_at is null and revoked_at is null`,
    [email],
  );
  const { rows } = await client.query<{ id: string; hospital_name: string }>(
    `insert into invites (tenant_id, email, name, role_id, invited_by, token_hash, expires_at)
     values (app_tenant_id(), $1, $2, $3, $4, $5, now() + make_interval(hours => $6))
     returning id, (select name from tenants where id = app_tenant_id()) as hospital_name`,
    [email, input.name.trim(), input.roleId, input.invitedBy, hash, config.INVITE_TTL_HOURS],
  );
  const row = rows[0];
  if (!row) throw new Error('invite was not created');
  return {
    id: row.id,
    email,
    hospitalName: row.hospital_name,
    token,
    expiresInHours: config.INVITE_TTL_HOURS,
  };
}

export function sendInvite(notifier: Notifier, invite: IssuedInvite): Promise<void> {
  return notifier.send({
    to: invite.email,
    template: 'invite',
    data: {
      hospitalName: invite.hospitalName,
      linkPath: `/invite?token=${invite.token}`,
      expiresInHours: invite.expiresInHours,
    },
  });
}

const OPEN = 'accepted_at is null and revoked_at is null and expires_at > now()';

export interface InvitePreview {
  email: string;
  hospitalName: string;
  /** False when this person already has an account with a password: they only need to accept. */
  needsPassword: boolean;
}

/** What the invite screen shows before the person accepts. Null for a link that does not work. */
export async function inspectInvite(
  { client }: AuthTransaction,
  token: string | undefined,
): Promise<InvitePreview | null> {
  if (!isToken(token)) return null;
  const { rows } = await client.query<{
    email: string;
    hospital_name: string | null;
    has_password: boolean;
  }>(
    `select i.email, invite_hospital_name(i.token_hash) as hospital_name,
            exists (
              select from users u join user_identities p on p.user_id = u.id and p.provider = 'password'
              where u.email = i.email
            ) as has_password
     from invites i where i.token_hash = $1 and ${OPEN}`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row?.hospital_name) return null;
  return { email: row.email, hospitalName: row.hospital_name, needsPassword: !row.has_password };
}

export type AcceptResult = 'accepted' | 'invalid' | 'password_required' | PasswordProblem;

/**
 * Accepts an invite: the person becomes a member of the hospital in the invited role. Someone
 * new also gets an account and sets their password here. Someone who already has one keeps it
 * (holding the link proves they own the address) and any password sent is ignored.
 *
 * Nothing is used up unless the whole thing succeeds, so a rejected password can be corrected
 * with the same link. After success the link is dead.
 */
export async function acceptInvite(
  { client, identify }: AuthTransaction,
  token: string | undefined,
  password: string | undefined,
): Promise<AcceptResult> {
  if (!isToken(token)) return 'invalid';
  const invites = await client.query<{
    id: string;
    tenant_id: string;
    email: string;
    name: string;
    role_id: string;
  }>(
    `select id, tenant_id, email, name, role_id from invites
     where token_hash = $1 and ${OPEN} for update`,
    [hashToken(token)],
  );
  const invite = invites.rows[0];
  if (!invite) return 'invalid';

  const users = await client.query<{ id: string; status: string; has_password: boolean }>(
    `select u.id, u.status,
            exists (select from user_identities p where p.user_id = u.id and p.provider = 'password') as has_password
     from users u where u.email = $1 for update`,
    [invite.email],
  );
  const existing = users.rows[0];
  // A disabled account is not reopened by an invite.
  if (existing && existing.status !== 'active') return 'invalid';

  let secretHash: string | undefined;
  if (!existing?.has_password) {
    if (!password) return 'password_required';
    const problem = passwordProblem(password, { email: invite.email });
    if (problem) return problem;
    secretHash = await hashPassword(password);
  }

  let userId = existing?.id;
  if (!userId) {
    const created = await client.query<{ id: string }>(
      'insert into users (email, name) values ($1, $2) returning id',
      [invite.email, invite.name],
    );
    userId = created.rows[0]?.id;
    if (!userId) throw new Error('user was not created');
  }
  if (secretHash) {
    await client.query(
      `insert into user_identities (user_id, provider, subject, secret_hash)
       values ($1::uuid, 'password', $1::text, $2)`,
      [userId, secretHash],
    );
  }

  await identify(userId);
  // The database checks this against the open invite (see the policy in migration 0005), so it
  // must come before the invite is marked accepted.
  await client.query(
    `insert into memberships (tenant_id, user_id, role_id) values ($1, $2, $3)
     on conflict (tenant_id, user_id) do nothing`,
    [invite.tenant_id, userId, invite.role_id],
  );
  await client.query('update invites set accepted_at = now() where id = $1', [invite.id]);
  return 'accepted';
}
