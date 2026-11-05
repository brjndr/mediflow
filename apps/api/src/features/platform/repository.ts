import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withAuthTransaction } from '../../core/auth/db.js';
import { newToken } from '../../core/auth/sessions.js';
import { HttpError } from '../../core/http/errors.js';
import type { PlatformAuditEntry, PlatformHospital } from './schemas.js';

/** Columns of a hospital as the API shows it, with its head count and module flags. */
const HOSPITAL = `
  t.id, t.slug, t.name, t.locale, t.timezone, t.currency, t.theme_primary, t.theme_logo_url,
  t.address, t.phone, t.registration_number, t.auth_mode, t.region, t.status, t.max_users,
  t.storage_mb, t.version, t.created_at, t.created_at::text as cursor_at, t.suspended_at, t.offboarding_requested_at, t.delete_after,
  (select count(*)::int from memberships m where m.tenant_id = t.id and m.status = 'active') as members,
  coalesce(
    (select jsonb_agg(jsonb_build_object('feature', f.feature, 'enabled', f.enabled) order by f.feature)
     from tenant_features f where f.tenant_id = t.id),
    '[]'::jsonb
  ) as features`;

interface HospitalRow {
  id: string;
  slug: string;
  name: string;
  locale: string;
  timezone: string;
  currency: string;
  theme_primary: string;
  theme_logo_url: string | null;
  address: string | null;
  phone: string | null;
  registration_number: string | null;
  auth_mode: 'password' | 'sso';
  region: string | null;
  status: PlatformHospital['status'];
  max_users: number | null;
  storage_mb: number | null;
  version: number;
  created_at: Date;
  cursor_at: string;
  suspended_at: Date | null;
  offboarding_requested_at: Date | null;
  delete_after: Date | null;
  members: number;
  features: { feature: string; enabled: boolean }[];
}

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

function toHospital(row: HospitalRow): PlatformHospital {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency,
    themePrimary: row.theme_primary,
    themeLogoUrl: row.theme_logo_url,
    address: row.address,
    phone: row.phone,
    registrationNumber: row.registration_number,
    authMode: row.auth_mode,
    region: row.region,
    status: row.status,
    maxUsers: row.max_users,
    storageMb: row.storage_mb,
    version: row.version,
    memberCount: row.members,
    features: row.features,
    createdAt: row.created_at.toISOString(),
    suspendedAt: iso(row.suspended_at),
    offboardingRequestedAt: iso(row.offboarding_requested_at),
    deleteAfter: iso(row.delete_after),
  };
}

export async function findHospital(
  client: pg.ClientBase,
  id: string,
): Promise<PlatformHospital | null> {
  const { rows } = await client.query<HospitalRow>(
    `select ${HOSPITAL} from tenants t where t.id = $1`,
    [id],
  );
  return rows[0] ? toHospital(rows[0]) : null;
}

export async function getHospital(client: pg.ClientBase, id: string): Promise<PlatformHospital> {
  const hospital = await findHospital(client, id);
  if (!hospital) throw new HttpError(404, 'not_found', 'No such hospital');
  return hospital;
}

/** Postgres’s own text for a timestamptz, which keeps its microseconds (a JS date does not). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** A page position: the sort key and the id, so rows with the same time keep a stable order. */
interface Position {
  at: string;
  id: string;
}

/** The date part of a cursor must be a real day (the shape alone lets 2026-99-99 through). */
function isRealDate(at: string): boolean {
  const day = at.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  const hour = Number(at.slice(11, 13));
  const minute = Number(at.slice(14, 16));
  const second = Number(at.slice(17, 19));
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(day) &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

export const encodeCursor = (position: Position): string =>
  Buffer.from(JSON.stringify(position)).toString('base64url');

export function decodeCursor(cursor: string | undefined): Position | null {
  if (cursor === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value === 'object' && value !== null) {
      const { at, id } = value as Record<string, unknown>;
      if (
        typeof at === 'string' &&
        typeof id === 'string' &&
        TIMESTAMP.test(at) &&
        isRealDate(at) &&
        /^[0-9a-f-]{36}$/i.test(id)
      ) {
        return { at, id };
      }
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
}

/** Newest first. A search term is part of a name or slug; a hospital's name is not patient data. */
export async function listHospitals(
  client: pg.ClientBase,
  input: { cursor?: string; limit: number; status?: string; term?: string },
): Promise<{ items: PlatformHospital[]; nextCursor: string | null }> {
  const from = decodeCursor(input.cursor);
  const { rows } = await client.query<HospitalRow>(
    `select ${HOSPITAL} from tenants t
     where ($1::text is null or t.status = $1)
       and ($2::text is null or strpos(lower(t.name), lower($2)) > 0 or strpos(t.slug, lower($2)) > 0)
       and ($3::timestamptz is null or (t.created_at, t.id) < ($3, $4::uuid))
     order by t.created_at desc, t.id desc
     limit $5`,
    [input.status ?? null, input.term ?? null, from?.at ?? null, from?.id ?? null, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toHospital),
    nextCursor:
      rows.length > input.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  };
}

export interface AuditInput {
  actorId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  hospitalId?: string | null;
  /** Ids and codes only. */
  detail?: Record<string, string | number | boolean | null>;
  requestId?: string;
}

/** Adds to the platform's trail, in the transaction of the change it describes. */
export async function recordPlatformAudit(client: pg.ClientBase, input: AuditInput): Promise<void> {
  await client.query(
    `insert into platform_audit_log (actor_id, action, entity, entity_id, hospital_id, detail, request_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.actorId,
      input.action,
      input.entity,
      input.entityId ?? null,
      input.hospitalId ?? null,
      JSON.stringify(input.detail ?? {}),
      input.requestId ?? null,
    ],
  );
}

export async function listAudit(
  client: pg.ClientBase,
  input: { cursor?: string; limit: number; hospitalId?: string },
): Promise<{ items: PlatformAuditEntry[]; nextCursor: string | null }> {
  const from = decodeCursor(input.cursor);
  const { rows } = await client.query<{
    id: string;
    at: Date;
    cursor_at: string;
    actor_id: string;
    action: string;
    entity: string;
    entity_id: string | null;
    hospital_id: string | null;
    detail: PlatformAuditEntry['detail'];
  }>(
    `select id, at, at::text as cursor_at, actor_id, action, entity, entity_id, hospital_id, detail
     from platform_audit_log
     where ($1::uuid is null or hospital_id = $1)
       and ($2::timestamptz is null or (at, id) < ($2, $3::uuid))
     order by at desc, id desc
     limit $4`,
    [input.hospitalId ?? null, from?.at ?? null, from?.id ?? null, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      actorId: row.actor_id,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      hospitalId: row.hospital_id,
      detail: row.detail,
    })),
    nextCursor:
      rows.length > input.limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  };
}

/**
 * Invites the first admin of a hospital. Saved with a hash that matches no token, as every invite
 * is: the email job gives it a token when it sends the link (core/auth/emails.ts). An earlier open
 * invite to the same address is withdrawn, so only the newest link works.
 */
export async function createAdminInvite(
  client: pg.ClientBase,
  input: {
    hospitalId: string;
    email: string;
    name: string;
    invitedBy: string;
    ttlHours: number;
  },
): Promise<{ id: string; email: string; expiresAt: string }> {
  await client.query(
    `update invites set revoked_at = now()
     where tenant_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
    [input.hospitalId, input.email],
  );
  const { rows } = await client.query<{ id: string; expires_at: Date }>(
    `insert into invites (tenant_id, email, name, role_id, invited_by, token_hash, expires_at)
     values ($1, $2, $3, 'admin', $4, $5, now() + make_interval(hours => $6))
     returning id, expires_at`,
    [input.hospitalId, input.email, input.name, input.invitedBy, newToken().hash, input.ttlHours],
  );
  const row = rows[0];
  if (!row) throw new Error('invite was not created');
  return { id: row.id, email: input.email, expiresAt: row.expires_at.toISOString() };
}

/** JSON with the keys of an object in order, so the same request in another key order is the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

/** What a request with an idempotency key asked for, to tell a repeat from a different request. */
export const requestHash = (operation: string, body: unknown): Buffer =>
  createHash('sha256')
    .update(`${operation}\n${stableJson(body)}`)
    .digest();

/**
 * Serialises requests with one key (two at once wait for each other), then returns the id of what
 * the first one made, or null when this is the first. The same key with another request is 422.
 */
export async function claimKey(
  client: pg.ClientBase,
  userId: string,
  key: string,
  hash: Buffer,
): Promise<string | null> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${key}`]);
  // A key lives a day, as in core/idempotency; this keeps the table small without a job.
  await client.query(
    "delete from platform_requests where created_at < now() - interval '24 hours'",
  );
  const { rows } = await client.query<{ request_hash: Buffer; entity_id: string }>(
    'select request_hash, entity_id from platform_requests where user_id = $1 and key = $2',
    [userId, key],
  );
  const prior = rows[0];
  if (!prior) return null;
  if (!prior.request_hash.equals(hash)) {
    throw new HttpError(
      422,
      'idempotency_key_reuse',
      'This Idempotency-Key was used for a different request',
    );
  }
  return prior.entity_id;
}

export async function rememberKey(
  client: pg.ClientBase,
  userId: string,
  key: string,
  hash: Buffer,
  entityId: string,
): Promise<void> {
  await client.query(
    'insert into platform_requests (user_id, key, request_hash, entity_id) values ($1, $2, $3, $4)',
    [userId, key, hash, entityId],
  );
}

/** Whether any active member of the hospital holds the admin role. */
export async function hasActiveAdmin(client: pg.ClientBase, hospitalId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from memberships where tenant_id = $1 and role_id = 'admin' and status = 'active' limit 1",
    [hospitalId],
  );
  return rowCount !== 0;
}

export async function isPlatformAdminEmail(client: pg.ClientBase, email: string): Promise<boolean> {
  const { rows } = await client.query<{ found: boolean }>(
    'select is_platform_admin_email($1) as found',
    [email],
  );
  return rows[0]?.found === true;
}

/** Withdraws the invites still open at a hospital, so no one can join a closing one. */
export async function withdrawOpenInvites(
  client: pg.ClientBase,
  hospitalId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `update invites set revoked_at = now()
     where tenant_id = $1 and accepted_at is null and revoked_at is null`,
    [hospitalId],
  );
  return rowCount ?? 0;
}

/**
 * Ends every session that is working at the hospital, so its staff are signed out of it at once.
 * Sessions are the authentication role's, so this is its transaction, not the platform's. A
 * session that is not at the hospital is left alone. Safe to repeat.
 */
export async function endHospitalSessions(pool: pg.Pool, hospitalId: string): Promise<number> {
  return withAuthTransaction(pool, async ({ client }) => {
    const { rowCount } = await client.query(
      `update sessions set revoked_at = now(), revoke_reason = 'admin'
       where active_tenant_id = $1 and revoked_at is null`,
      [hospitalId],
    );
    return rowCount ?? 0;
  });
}
