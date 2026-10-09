import type pg from 'pg';
import type { Config } from '../config/config.js';
import type { AuthTransaction } from './db.js';
import { checkSecondFactor, isMfaEnabled } from './mfa.js';
import { verifyAgainstNothing, verifyPassword } from './password.js';

type LoginConfig = Pick<Config, 'LOGIN_MAX_FAILURES' | 'LOGIN_LOCK_MINUTES' | 'MFA_ENCRYPTION_KEY'>;

interface Candidate {
  id: string;
  status: string;
  locked: boolean;
  secret_hash: string | null;
}

export type LoginResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      /**
       * `invalid_credentials` covers every way the first step can fail. The other two are only
       * ever returned after the right password, so they reveal nothing an attacker did not know.
       */
      reason: 'invalid_credentials' | 'mfa_required' | 'invalid_mfa_code';
    };

/** Emails are compared lower-cased and trimmed, as they are stored. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Counts a failed attempt, and locks the account when it is one too many. */
async function recordFailure(
  client: pg.PoolClient,
  config: LoginConfig,
  userId: string,
): Promise<void> {
  await client.query(
    `update users
     set failed_login_count = case when failed_login_count + 1 >= $2 then 0 else failed_login_count + 1 end,
         locked_until = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end,
         updated_at = now()
     where id = $1`,
    [userId, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
  );
}

/**
 * Checks an email and password, and the second factor when the user has one.
 *
 * `invalid_credentials` covers no such account, wrong password, disabled account and locked
 * account, and the caller must answer all of them identically. Each of those paths also does the
 * same amount of password hashing, so neither the response nor its timing tells an attacker
 * which emails have accounts.
 *
 * After LOGIN_MAX_FAILURES wrong passwords or wrong codes the account is locked for
 * LOGIN_LOCK_MINUTES. While locked, even the correct password is refused, and attempts do not
 * extend the lock. The row is locked for the duration of the check, so parallel guesses are
 * counted one by one.
 *
 * On success the transaction is identified as the user.
 */
export async function authenticate(
  { client, identify }: AuthTransaction,
  config: LoginConfig,
  attempt: { email: string; password: string; code?: string | undefined },
): Promise<LoginResult> {
  const { rows } = await client.query<Candidate>(
    `select u.id, u.status,
            (u.locked_until is not null and u.locked_until > now()) as locked,
            i.secret_hash
     from users u
     left join user_identities i on i.user_id = u.id and i.provider = 'password'
     where u.email = $1
     for update of u`,
    [normalizeEmail(attempt.email)],
  );
  const user = rows[0];

  if (!user || !user.secret_hash || user.status !== 'active' || user.locked) {
    await verifyAgainstNothing(attempt.password);
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (!(await verifyPassword(user.secret_hash, attempt.password))) {
    await recordFailure(client, config, user.id);
    return { ok: false, reason: 'invalid_credentials' };
  }

  // The password is right, so the database may now show this user's own second factor.
  await identify(user.id);
  if (await isMfaEnabled(client, user.id)) {
    // Asking for the code is not a failure, and not yet a success either.
    if (!attempt.code) return { ok: false, reason: 'mfa_required' };
    if (!(await checkSecondFactor(client, config, user.id, attempt.code))) {
      // Guessing codes is limited exactly as guessing passwords is.
      await recordFailure(client, config, user.id);
      return { ok: false, reason: 'invalid_mfa_code' };
    }
  }

  await client.query(
    `update users set failed_login_count = 0, locked_until = null, updated_at = now()
     where id = $1 and (failed_login_count <> 0 or locked_until is not null)`,
    [user.id],
  );
  return { ok: true, userId: user.id };
}
