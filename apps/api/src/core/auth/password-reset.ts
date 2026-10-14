import type { Config } from '../config/config.js';
import type { AuthTransaction } from './db.js';
import { normalizeEmail } from './login.js';
import { hashPassword, passwordProblem, type PasswordProblem } from './password.js';
import { hashToken, isToken, newToken } from './sessions.js';

type ResetConfig = Pick<Config, 'PASSWORD_RESET_TTL_MINUTES'>;

/** One reset email per account per this long, so the form cannot be used to flood an inbox. */
const MIN_SECONDS_BETWEEN_EMAILS = 60;

export interface IssuedReset {
  id: string;
}

/**
 * Creates a reset link for the account with this email, or returns null when there is nothing
 * to send (no such account, a disabled one, one that signs in without a password, or a link sent
 * a moment ago). The caller must answer the same way in both cases, so the form does not reveal
 * which emails have accounts. A new link replaces any earlier one.
 *
 * The link is saved with a hash that matches no token. Queue the email with
 * `queuePasswordResetEmail` (core/auth/emails.ts) after the commit: the job gives the link its
 * token when it sends it.
 */
export async function requestPasswordReset(
  { client }: AuthTransaction,
  config: ResetConfig,
  email: string,
): Promise<IssuedReset | null> {
  const users = await client.query<{ id: string; email: string }>(
    `select u.id, u.email from users u
     join user_identities p on p.user_id = u.id and p.provider = 'password'
     where u.email = $1 and u.status = 'active'
     for update of u`,
    [normalizeEmail(email)],
  );
  const user = users.rows[0];
  if (!user) return null;

  const recent = await client.query(
    'select 1 from password_resets where user_id = $1 and created_at > now() - make_interval(secs => $2)',
    [user.id, MIN_SECONDS_BETWEEN_EMAILS],
  );
  if (recent.rowCount !== 0) return null;

  // The token of this hash is thrown away: the email job replaces the hash with that of its own.
  const { hash } = newToken();
  await client.query(
    'update password_resets set used_at = now() where user_id = $1 and used_at is null',
    [user.id],
  );
  const inserted = await client.query<{ id: string }>(
    `insert into password_resets (user_id, token_hash, expires_at)
     values ($1, $2, now() + make_interval(mins => $3))
     returning id`,
    [user.id, hash, config.PASSWORD_RESET_TTL_MINUTES],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('reset was not created');
  return { id };
}

export type ResetResult = 'reset' | 'invalid' | PasswordProblem;

/**
 * Sets a new password with a reset link. The link is used up only on success, so a rejected
 * password can be corrected with the same link.
 *
 * On success every session of the user ends: whoever knew the old password, or held a stolen
 * cookie, is signed out. A lockout from failed sign-ins is lifted. The second factor is not
 * touched: a reset proves control of the mailbox, not of the authenticator.
 */
export async function resetPassword(
  { client }: AuthTransaction,
  token: string | undefined,
  password: string,
): Promise<ResetResult> {
  if (!isToken(token)) return 'invalid';
  const { rows } = await client.query<{ id: string; user_id: string; email: string }>(
    `select r.id, r.user_id, u.email from password_resets r
     join users u on u.id = r.user_id and u.status = 'active'
     where r.token_hash = $1 and r.used_at is null and r.expires_at > now()
     for update of r`,
    [hashToken(token)],
  );
  const reset = rows[0];
  if (!reset) return 'invalid';

  const problem = passwordProblem(password, { email: reset.email });
  if (problem) return problem;

  const updated = await client.query(
    `update user_identities set secret_hash = $2, updated_at = now()
     where user_id = $1 and provider = 'password'`,
    [reset.user_id, await hashPassword(password)],
  );
  if (updated.rowCount !== 1) return 'invalid';

  await client.query('update password_resets set used_at = now() where id = $1', [reset.id]);
  await client.query(
    `update sessions set revoked_at = now(), revoke_reason = 'password_changed'
     where user_id = $1 and revoked_at is null`,
    [reset.user_id],
  );
  await client.query(
    'update users set failed_login_count = 0, locked_until = null, updated_at = now() where id = $1',
    [reset.user_id],
  );
  return 'reset';
}
