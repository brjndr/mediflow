import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { normalizeEmail } from '../auth/login.js';
import { hashPassword } from '../auth/password.js';
import { newToken } from '../auth/sessions.js';

/** How long the first set-password link works. Longer than a reset: it is read off a terminal. */
const LINK_HOURS = 24;

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapResult {
  created: boolean;
  /** Where to send the person, from `APP_BASE_URL`. The only place the token is ever shown. */
  linkPath: string;
  expiresInHours: number;
}

/**
 * Makes a platform admin, or gives an existing one a new set-password link (a lost account).
 *
 * This is the only way one is made: a deploy-time command on the owner connection, never an API
 * route or a screen. The account has a password nobody knows, so it cannot sign in until its owner
 * follows the link and chooses one; and a platform route stays closed (403 `mfa_required`) until
 * they have also confirmed an authenticator, so a link alone is not enough to use it.
 *
 * It refuses an address that belongs to a hospital's staff: promoting such an account would hand
 * it a second life that the hospital's admin cannot see.
 */
export async function bootstrapPlatformAdmin(
  pool: pg.Pool,
  input: { email: string; name: string },
): Promise<BootstrapResult> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
    throw new BootstrapError('The email is not an address.');
  }
  if (name === '' || name.length > 200)
    throw new BootstrapError('Give a name of 1 to 200 letters.');

  const client = await pool.connect();
  try {
    await client.query('begin');
    const found = await client.query<{ id: string; is_platform_admin: boolean }>(
      'select id, is_platform_admin from users where email = $1 for update',
      [email],
    );
    let userId = found.rows[0]?.id;
    const created = userId === undefined;
    if (found.rows[0] && !found.rows[0].is_platform_admin) {
      throw new BootstrapError(
        'That address belongs to a hospital staff account. Use another address.',
      );
    }
    if (userId === undefined) {
      const inserted = await client.query<{ id: string }>(
        'insert into users (email, name, is_platform_admin) values ($1, $2, true) returning id',
        [email, name],
      );
      userId = inserted.rows[0]?.id;
      if (!userId) throw new Error('user was not created');
      // A password nobody knows; the link below replaces it.
      await client.query(
        `insert into user_identities (user_id, provider, subject, secret_hash)
         values ($1::uuid, 'password', $1::text, $2)`,
        [userId, await hashPassword(randomBytes(32).toString('base64'))],
      );
    }
    await client.query(
      'update password_resets set used_at = now() where user_id = $1 and used_at is null',
      [userId],
    );
    const { token, hash } = newToken();
    await client.query(
      `insert into password_resets (user_id, token_hash, expires_at)
       values ($1, $2, now() + make_interval(hours => $3))`,
      [userId, hash, LINK_HOURS],
    );
    await client.query('commit');
    return {
      created,
      linkPath: `/reset-password?token=${token}`,
      expiresInHours: LINK_HOURS,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
