import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config/config.js';
import type { AuthTransaction } from './db.js';

/**
 * Server-side sessions.
 *
 * The browser holds a random token in an httpOnly cookie. The database holds only the SHA-256
 * hash of it, the user, and the one hospital that is active. Nothing about the session is
 * readable or forgeable by the client.
 *
 * A session ends when it is unused for SESSION_IDLE_MINUTES, when SESSION_ABSOLUTE_HOURS have
 * passed since sign-in, when the user signs out, or when its token is seen after being replaced.
 * While in use its token is replaced every SESSION_ROTATE_MINUTES, which limits how long a copied
 * cookie is useful and lets a copy be noticed.
 */

type SessionConfig = Pick<
  Config,
  'SESSION_IDLE_MINUTES' | 'SESSION_ABSOLUTE_HOURS' | 'SESSION_ROTATE_MINUTES'
>;

/** A replaced token still works for this long, for requests that were already on their way. */
export const ROTATION_GRACE_SECONDS = 30;
/** last_seen_at is written at most this often, to keep read-only requests cheap. */
const TOUCH_INTERVAL_SECONDS = 60;

export type RevokeReason =
  'logout' | 'idle' | 'expired' | 'token_reuse' | 'replaced' | 'password_changed' | 'admin';

export interface ActiveSession {
  id: string;
  userId: string;
  /** The one active hospital, or null until the user picks one. */
  tenantId: string | null;
}

export interface NewToken {
  /** Goes in the cookie. Never stored and never logged. */
  token: string;
  hash: Buffer;
}

export function newToken(): NewToken {
  // 256 bits from the operating system's generator: not guessable, not derived from anything.
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Tokens this module issues are 43 base64url characters. Anything else is not looked up. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Whether a string could be a token from `newToken` at all. Session, invite and reset links share the shape. */
export const isToken = (value: string | undefined): value is string =>
  value !== undefined && TOKEN_SHAPE.test(value);

export async function createSession(
  client: pg.PoolClient,
  config: SessionConfig,
  { userId, tenantId }: { userId: string; tenantId: string | null },
): Promise<{ session: ActiveSession; token: string }> {
  const { token, hash } = newToken();
  const { rows } = await client.query<{ id: string }>(
    `insert into sessions (user_id, active_tenant_id, token_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(hours => $4))
     returning id`,
    [userId, tenantId, hash, config.SESSION_ABSOLUTE_HOURS],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('session was not created');
  return { session: { id, userId, tenantId }, token };
}

export async function revokeSession(
  client: pg.PoolClient,
  sessionId: string,
  reason: RevokeReason,
): Promise<void> {
  await client.query(
    'update sessions set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null',
    [sessionId, reason],
  );
}

/** Ends the session a token belongs to, if any. Used at sign-out and when a browser signs in again. */
export async function revokeSessionByToken(
  client: pg.PoolClient,
  token: string | undefined,
  reason: RevokeReason,
): Promise<void> {
  if (!token || !TOKEN_SHAPE.test(token)) return;
  const hash = hashToken(token);
  await client.query(
    `update sessions set revoked_at = now(), revoke_reason = $2
     where (token_hash = $1 or previous_token_hash = $1) and revoked_at is null`,
    [hash, reason],
  );
}

export type ResolvedSession =
  | {
      ok: true;
      session: ActiveSession;
      /** Set when the token was replaced: send it as the new cookie. */ rotatedToken?: string;
    }
  | { ok: false };

interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  is_previous: boolean;
  revoked: boolean;
  expired: boolean;
  idle: boolean;
  seconds_since_rotation: number;
  seconds_since_seen: number;
}

/**
 * Turns the cookie's token into a session, or nothing. Every reason for refusing looks the same
 * to the caller. All time comparisons use the database clock, so they do not depend on the clocks
 * of the API instances agreeing.
 */
export async function resolveSession(
  { client, identify }: AuthTransaction,
  config: SessionConfig,
  token: string | undefined,
): Promise<ResolvedSession> {
  if (!token || !TOKEN_SHAPE.test(token)) return { ok: false };
  const hash = hashToken(token);

  const { rows } = await client.query<SessionRow>(
    `select id, user_id, active_tenant_id,
            (previous_token_hash is not distinct from $1) as is_previous,
            (revoked_at is not null) as revoked,
            (now() >= expires_at) as expired,
            (now() - last_seen_at > make_interval(mins => $2)) as idle,
            extract(epoch from now() - rotated_at)::float8 as seconds_since_rotation,
            extract(epoch from now() - last_seen_at)::float8 as seconds_since_seen
     from sessions
     where token_hash = $1 or previous_token_hash = $1
     for update`,
    [hash, config.SESSION_IDLE_MINUTES],
  );
  const row = rows[0];
  if (!row || row.revoked) return { ok: false };

  if (row.expired || row.idle) {
    await revokeSession(client, row.id, row.expired ? 'expired' : 'idle');
    return { ok: false };
  }

  let rotatedToken: string | undefined;
  if (row.is_previous) {
    // A token that has already been replaced. Just after a rotation that is a request that was in
    // flight. Later, it means two parties hold tokens of one session: end it for both.
    if (row.seconds_since_rotation > ROTATION_GRACE_SECONDS) {
      await revokeSession(client, row.id, 'token_reuse');
      return { ok: false };
    }
  } else if (row.seconds_since_rotation >= config.SESSION_ROTATE_MINUTES * 60) {
    const next = newToken();
    await client.query(
      `update sessions
       set token_hash = $2, previous_token_hash = $3, rotated_at = now(), last_seen_at = now()
       where id = $1`,
      [row.id, next.hash, hash],
    );
    rotatedToken = next.token;
  }

  if (!rotatedToken && row.seconds_since_seen >= TOUCH_INTERVAL_SECONDS) {
    await client.query('update sessions set last_seen_at = now() where id = $1', [row.id]);
  }

  // From here the database knows whose transaction this is.
  await identify(row.user_id);
  const user = await client.query<{ status: string }>('select status from users where id = $1', [
    row.user_id,
  ]);
  if (user.rows[0]?.status !== 'active') {
    await revokeSession(client, row.id, 'admin');
    return { ok: false };
  }

  // The active hospital holds only while the user is still an active member of it.
  let tenantId = row.active_tenant_id;
  if (tenantId) {
    const member = await client.query(
      "select 1 from memberships where tenant_id = $1 and user_id = $2 and status = 'active'",
      [tenantId, row.user_id],
    );
    if (member.rowCount === 0) {
      await client.query('update sessions set active_tenant_id = null where id = $1', [row.id]);
      tenantId = null;
    }
  }

  return { ok: true, session: { id: row.id, userId: row.user_id, tenantId }, rotatedToken };
}

/**
 * Binds the session to another of the user's hospitals. Returns false, changing nothing, when the
 * user is not an active member of it (which is also the answer for a hospital that does not
 * exist, so the two cannot be told apart). The token is replaced, as on any change of what a
 * session may reach.
 */
export async function switchTenant(
  { client }: AuthTransaction,
  session: ActiveSession,
  tenantId: string,
): Promise<{ token: string } | null> {
  const member = await client.query(
    "select 1 from memberships where tenant_id = $1 and user_id = $2 and status = 'active'",
    [tenantId, session.userId],
  );
  if (member.rowCount === 0) return null;
  const next = newToken();
  await client.query(
    `update sessions
     set active_tenant_id = $2, token_hash = $3, previous_token_hash = token_hash,
         rotated_at = now(), last_seen_at = now()
     where id = $1`,
    [session.id, tenantId, next.hash],
  );
  return { token: next.token };
}
