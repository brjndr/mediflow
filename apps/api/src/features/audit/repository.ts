import type pg from 'pg';

export interface AuditFilter {
  from: string;
  to: string;
  actorId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  cursor?: string;
  limit: number;
}

interface Row {
  id: string;
  at_text: string;
  at: Date;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  detail: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decode(cursor: string): { at: string; id: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { at, id } = value as Record<string, unknown>;
    if (typeof at !== 'string' || typeof id !== 'string' || !UUID.test(id)) return null;
    if (Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export interface AuditItem {
  id: string;
  at: string;
  actor: { id: string; name: string } | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail: string | null;
}

/**
 * The hospital's audit entries in a range of its own days, newest first. The cursor keeps the
 * row's time as text so microseconds survive. Null for a cursor that is not one of ours.
 * `actor_id` is text (a user id, or nothing for system work); the name is the account's.
 */
export async function searchAudit(
  client: pg.ClientBase,
  filter: AuditFilter,
): Promise<{ items: AuditItem[]; nextCursor: string | null } | null> {
  const after = filter.cursor === undefined ? undefined : decode(filter.cursor);
  if (after === null) return null;
  const { rows } = await client.query<Row>(
    `select a.id, a.at::text as at_text, a.at, a.actor_id, u.name as actor_name, a.action,
            a.entity, a.entity_id, a.detail
     from tenants t
     cross join lateral (select
       ($1::date::timestamp at time zone t.timezone) as lo,
       (($2::date + 1)::timestamp at time zone t.timezone) as hi) b
     join audit_log a on a.tenant_id = t.id and a.at >= b.lo and a.at < b.hi
     left join users u on u.id::text = a.actor_id
     where t.id = app_tenant_id()
       and ($3::text is null or a.actor_id = $3)
       and ($4::text is null or a.entity = $4)
       and ($5::text is null or a.entity_id = $5)
       and ($6::text is null or a.action = $6)
       and ($7::timestamptz is null or (a.at, a.id) < ($7::timestamptz, $8::uuid))
     order by a.at desc, a.id desc
     limit $9`,
    [
      filter.from,
      filter.to,
      filter.actorId ?? null,
      filter.entity ?? null,
      filter.entityId ?? null,
      filter.action ?? null,
      after?.at ?? null,
      after?.id ?? null,
      filter.limit + 1,
    ],
  );
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor_id === null ? null : { id: r.actor_id, name: r.actor_name ?? '' },
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: r.detail,
    })),
    nextCursor:
      rows.length > filter.limit && last
        ? Buffer.from(JSON.stringify({ at: last.at_text, id: last.id })).toString('base64url')
        : null,
  };
}
