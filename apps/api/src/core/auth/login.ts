import type { Config } from '../config/config.js';
import type { AuthTransaction } from './db.js';
import { verifyAgainstNothing, verifyPassword } from './password.js';

type LoginConfig = Pick<Config, 'LOGIN_MAX_FAILURES' | 'LOGIN_LOCK_MINUTES'>;

interface Candidate {
  id: string;
  status: string;
  locked: boolean;
  secret_hash: string | null;
}

/** Emails are compared lower-cased and trimmed, as they are stored. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks an email and password. Returns the user's id, or null.
 *
 * Null covers every way this can fail (no such account, wrong password, disabled account, locked
 * account) and the caller must answer all of them identically. Each path also does the same
 * amount of password hashing, so neither the response nor its timing tells an attacker which
 * emails have accounts.
 *
 * After LOGIN_MAX_FAILURES wrong passwords the account is locked for LOGIN_LOCK_MINUTES. While
 * locked, even the correct password is refused, and attempts do not extend the lock. The row is
 * locked for the duration of the check, so parallel guesses are counted one by one.
 */
export async function authenticate(
  { client }: AuthTransaction,
  config: LoginConfig,
  email: string,
  password: string,
): Promise<string | null> {
  const { rows } = await client.query<Candidate>(
    `select u.id, u.status,
            (u.locked_until is not null and u.locked_until > now()) as locked,
            i.secret_hash
     from users u
     left join user_identities i on i.user_id = u.id and i.provider = 'password'
     where u.email = $1
     for update of u`,
    [normalizeEmail(email)],
  );
  const user = rows[0];

  if (!user || !user.secret_hash || user.status !== 'active' || user.locked) {
    await verifyAgainstNothing(password);
    return null;
  }

  if (!(await verifyPassword(user.secret_hash, password))) {
    await client.query(
      `update users
       set failed_login_count = case when failed_login_count + 1 >= $2 then 0 else failed_login_count + 1 end,
           locked_until = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end,
           updated_at = now()
       where id = $1`,
      [user.id, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
    );
    return null;
  }

  await client.query(
    `update users set failed_login_count = 0, locked_until = null, updated_at = now()
     where id = $1 and (failed_login_count <> 0 or locked_until is not null)`,
    [user.id],
  );
  return user.id;
}
