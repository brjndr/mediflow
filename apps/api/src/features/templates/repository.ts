import type pg from 'pg';
import type { TemplateKind } from './placeholders.js';
import type { RedactionReason } from './schemas.js';

/**
 * The templates SQL. Every statement runs on the request's own transaction, so row-level security
 * limits it to the active hospital: no statement here names a tenant.
 */

export interface TemplateRow {
  id: string;
  tenant_id: string;
  kind: TemplateKind;
  name: string;
  name_lower: string;
  version: number;
  saved_at: Date;
  archived: boolean;
}

export interface VersionInfoRow {
  version: number;
  saved_at: Date;
  saved_by_name: string;
  redacted_at: Date | null;
}

export interface VersionRow extends VersionInfoRow {
  name: string;
  body: unknown;
  redacted_by_name: string | null;
  redaction_reason: RedactionReason | null;
}

const COLUMNS = 'id, tenant_id, kind, name, name_lower, version, saved_at, archived';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the next page starts: after this row, in name order. Holds a name and an id, no more. */
interface Cursor {
  n: string;
  i: string;
}

const encodeCursor = (row: TemplateRow): string =>
  Buffer.from(JSON.stringify({ n: row.name_lower, i: row.id } satisfies Cursor)).toString(
    'base64url',
  );

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
    // A name this module stored: never longer than a name, never a character Postgres refuses.
    return n.length <= 200 && !n.includes('\u0000') ? { n, i } : null;
  } catch {
    return null;
  }
}

export interface TemplateList {
  rows: TemplateRow[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/** One page of the hospital's templates in use (or archived), by name. Null for a bad cursor. */
export async function listTemplates(
  client: pg.ClientBase,
  {
    kind,
    archived,
    cursor,
    limit,
  }: { kind?: TemplateKind; archived: boolean; cursor?: string; limit: number },
): Promise<TemplateList | null> {
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  if (after === null) return null;
  const { rows } = await client.query<TemplateRow>(
    `select ${COLUMNS} from templates
     where archived = $1 and ($2::text is null or kind = $2)
       and ($3::text is null or (name_lower, id) > ($3, $4::uuid))
     order by name_lower, id
     limit $5`,
    [archived, kind ?? null, after?.n ?? null, after?.i ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const result: TemplateList = {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
  if (after === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from templates
       where archived = $1 and ($2::text is null or kind = $2)`,
      [archived, kind ?? null],
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The template, or null when this hospital has none such. Locked until the transaction ends when asked. */
export async function findTemplate(
  client: pg.ClientBase,
  id: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<TemplateRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<TemplateRow>(
    `select ${COLUMNS} from templates where id = $1${lock ? ' for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** The hospital's template of this kind and name, whatever the capitals, archived or not. */
export async function findByName(
  client: pg.ClientBase,
  kind: TemplateKind,
  name: string,
): Promise<TemplateRow | null> {
  const { rows } = await client.query<TemplateRow>(
    `select ${COLUMNS} from templates where kind = $1 and name_lower = lower($2)`,
    [kind, name],
  );
  return rows[0] ?? null;
}

/** Whether an error is the database refusing a second template of the same kind and name. */
export const isNameTaken = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505' &&
  (error as { constraint?: string }).constraint === 'templates_name_taken';

// The name of a member of this hospital's staff, which is all a hospital's requests see of an
// account. Someone whose name cannot be read is still a version's author: the name is then empty.
const VERSIONS = `select v.version, v.saved_at, coalesce(saver.name, '') as saved_by_name,
                         v.redacted_at
                  from template_versions v
                  left join users saver on saver.id = v.saved_by`;

/** Every version of a template, the newest first. A template has a bounded number. */
export async function listVersions(
  client: pg.ClientBase,
  templateId: string,
): Promise<VersionInfoRow[]> {
  const { rows } = await client.query<VersionInfoRow>(
    `${VERSIONS} where v.template_id = $1 order by v.version desc`,
    [templateId],
  );
  return rows;
}

/** One version of a template with its name and text, or null when it never had that one. */
export async function findVersion(
  client: pg.ClientBase,
  templateId: string,
  version: number,
): Promise<VersionRow | null> {
  const { rows } = await client.query<VersionRow>(
    `select v.version, v.saved_at, coalesce(saver.name, '') as saved_by_name, v.redacted_at,
            v.name, v.body, redactor.name as redacted_by_name, v.redaction_reason
     from template_versions v
     left join users saver on saver.id = v.saved_by
     left join users redactor on redactor.id = v.redacted_by
     where v.template_id = $1 and v.version = $2`,
    [templateId, version],
  );
  return rows[0] ?? null;
}

/** Adds a template as its version 1, saved by this member of staff. Gives its id. */
export async function insertTemplate(
  client: pg.ClientBase,
  userId: string,
  { kind, name, body }: { kind: TemplateKind; name: string; body: unknown },
): Promise<string> {
  // `now()` is the time the transaction began: the template and its version carry the same one.
  const { rows } = await client.query<{ id: string }>(
    `insert into templates (tenant_id, kind, name, saved_at)
     values (app_tenant_id(), $1, $2, now()) returning id`,
    [kind, name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('The template was not added');
  await client.query(
    `insert into template_versions (tenant_id, template_id, version, name, body, saved_at, saved_by)
     values (app_tenant_id(), $1, 1, $2, $3::jsonb, now(), $4)`,
    [id, name, JSON.stringify(body), userId],
  );
  return id;
}

/**
 * Adds the next version of a template the caller has locked, and makes it the newest. The
 * versions before it are not touched.
 */
export async function insertVersion(
  client: pg.ClientBase,
  userId: string,
  template: TemplateRow,
  { name, body }: { name: string; body: unknown },
): Promise<void> {
  await client.query(
    `insert into template_versions (tenant_id, template_id, version, name, body, saved_at, saved_by)
     values (app_tenant_id(), $1, $2, $3, $4::jsonb, now(), $5)`,
    [template.id, template.version + 1, name, JSON.stringify(body), userId],
  );
  await client.query(
    'update templates set version = $2, name = $3, saved_at = now() where id = $1',
    [template.id, template.version + 1, name],
  );
}

export async function setArchived(
  client: pg.ClientBase,
  id: string,
  archived: boolean,
): Promise<void> {
  await client.query('update templates set archived = $2 where id = $1', [id, archived]);
}

/**
 * Removes the name and the text of one version, and says who did, when and why. False when it
 * was redacted already: nothing is written.
 */
export async function redactVersion(
  client: pg.ClientBase,
  userId: string,
  templateId: string,
  version: number,
  reason: RedactionReason,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update template_versions
     set name = '', body = '{"type": "doc", "content": []}'::jsonb,
         redacted_at = now(), redacted_by = $3, redaction_reason = $4
     where template_id = $1 and version = $2 and redacted_at is null`,
    [templateId, version, userId, reason],
  );
  return rowCount === 1;
}
