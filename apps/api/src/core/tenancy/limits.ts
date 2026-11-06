import type pg from 'pg';
import { HttpError } from '../http/errors.js';

/**
 * A hospital's cap on staff (`tenants.max_users`, set by the platform, null for none). It counts
 * the people who hold a place: active members, plus open invitations to an address that is not
 * already an active member (an invitation is a place held until it is accepted, withdrawn or
 * expires). Runs in the hospital's own transaction, so row-level security keeps it to one hospital.
 */
export interface UserLimit {
  /** Null: the hospital has no limit. */
  max: number | null;
  /** Active members plus open invitations. */
  used: number;
}

/** Open invitations that hold a place: not already an active member's address. */
const COUNTED_INVITE = `i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  and not exists (select 1 from memberships m join users u on u.id = m.user_id
                  where m.status = 'active' and lower(u.email) = i.email)`;

/** The limit and the places taken, without locking anything. */
export async function readUserLimit(client: pg.ClientBase): Promise<UserLimit> {
  const { rows } = await client.query<{ max: number | null; used: string }>(
    `select (select max_users from tenants limit 1) as max,
            (select count(*) from memberships where status = 'active')
            + (select count(*) from invites i where ${COUNTED_INVITE}) as used`,
  );
  const row = rows[0];
  return { max: row?.max ?? null, used: Number(row?.used ?? 0) };
}

/**
 * Refuses with 409 `user_limit_reached` when one more place would pass the limit. Takes a lock
 * for the hospital first, so two requests that each see one place left cannot both take it: the
 * second waits for the first to commit and then counts again. (The app role may not lock the
 * `tenants` row, so the lock is an advisory one on the hospital's id.)
 *
 * `replacingInviteTo` is the address of a new invitation: an open invitation to the same address
 * is withdrawn by the new one, so it gives its place back.
 */
export async function requireUserPlace(
  client: pg.ClientBase,
  replacingInviteTo?: string,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtext('user_limit'), hashtext(app_tenant_id()::text))",
  );
  const { max, used } = await readUserLimit(client);
  if (max === null) return;
  let given = 0;
  if (replacingInviteTo !== undefined) {
    const { rows } = await client.query<{ n: string }>(
      `select count(*) as n from invites i
       where i.email = lower(btrim($1)) and ${COUNTED_INVITE}`,
      [replacingInviteTo],
    );
    given = Number(rows[0]?.n ?? 0);
  }
  if (used - given + 1 > max) {
    throw new HttpError(
      409,
      'user_limit_reached',
      'The hospital has reached the number of staff it is allowed',
    );
  }
}
