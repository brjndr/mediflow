import type pg from 'pg';
import type { CodeSystem } from './schemas.js';

/**
 * The codes SQL. The codes are shared by every hospital and read-only to a request. The
 * favourites carry the tenant, and every statement here runs on the request's own transaction,
 * so row-level security limits them to the active hospital: no statement names a tenant.
 */

export interface CodeRow {
  id: string;
  system: CodeSystem;
  code: string;
  title: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where the next page starts. A search gives the hospital's favourites first and then the other
 * codes, each in the order of the codes: the cursor says which of the two it is in, and the code
 * and id of the last row. No more than that.
 */
interface Cursor {
  /** `f`: among the favourites. `n`: among the others. */
  p: 'f' | 'n';
  c: string;
  i: string;
}

/** Before every code: where the codes that are not favourites start. */
const START = { c: '', i: '00000000-0000-0000-0000-000000000000' };

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

/** Null for anything that is not a cursor this module made. */
function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { p, c, i } = value as Record<string, unknown>;
    if ((p !== 'f' && p !== 'n') || typeof c !== 'string' || typeof i !== 'string') return null;
    // A code this module stored: never longer than one, never a character Postgres refuses.
    return c.length <= 20 && !c.includes('\u0000') && UUID.test(i) ? { p, c, i } : null;
  } catch {
    return null;
  }
}

const likeEscaped = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);
/**
 * A word as a regular expression that matches it and nothing else. Every character with a meaning
 * in an expression is ASCII, and only those are escaped: a backslash before a letter is an escape
 * of its own, and what counts as a letter outside ASCII (the vowel signs of Devanagari, say) is
 * the database's locale's to decide.
 */
const regexEscaped = (text: string) =>
  text.replace(/[^A-Za-z0-9\u0080-\u{10FFFF}]/gu, (char) => `\\${char}`);

/**
 * The words of what was typed, as conditions on `c`: each word starts the code, with or without
 * its dot, or starts a word of the title. Adds its parameters to `params`.
 */
function wordConditions(q: string | undefined, params: unknown[]): string[] {
  return (q ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      // `\m` is the start of a word. The database lower-cases the word: its idea of lower case
      // is not JavaScript's.
      params.push(regexEscaped(word));
      const title = `c.title_lower ~ ('\\m' || lower($${params.length}))`;
      // Codes are written in letters, digits, dots and dashes: lower case is the same anywhere.
      const plain = word.toLowerCase().replace(/\./g, '');
      // A word of dots alone is the start of no code: without this it would be the start of all.
      if (plain === '') return title;
      params.push(`${likeEscaped(plain)}%`);
      return `(c.code_plain like $${params.length} or ${title})`;
    });
}

const FAVOURITE = 'exists (select 1 from code_favourites f where f.code_id = c.id)';

export interface CodeSearch {
  system: CodeSystem;
  q?: string;
  /** True gives the favourites only. */
  favouritesOnly: boolean;
  cursor?: string;
  limit: number;
}

export interface CodeList {
  rows: (CodeRow & { favourite: boolean })[];
  nextCursor: string | null;
  /** With the first page only. */
  total?: number;
}

/**
 * One page of a code set: the hospital's favourites that match, in the order of the codes, and
 * then the other codes that match, in the same order. Two reads, each along the index of the
 * codes in order, so a page costs the same wherever it is in a set of a hundred thousand: sorting
 * the whole set favourites first would not. Null for a bad cursor.
 */
export async function searchCodes(
  client: pg.ClientBase,
  { system, q, favouritesOnly, cursor, limit }: CodeSearch,
): Promise<CodeList | null> {
  const from = cursor === undefined ? undefined : decodeCursor(cursor);
  if (from === null) return null;

  const params: unknown[] = [system];
  const where = ['c.system = $1', ...wordConditions(q, params)];
  const filters = params.length;

  /** Up to `take` codes after a row, in order, that are favourites or that are not. */
  const read = async (favourite: boolean, after: { c: string; i: string } | null, take: number) => {
    const { rows } = await client.query<CodeRow>(
      `select c.id, c.system, c.code, c.title from codes c
       where ${where.join(' and ')} and ${favourite ? '' : 'not '}${FAVOURITE}
         and ($${filters + 1}::text is null
           or (c.code collate "C", c.id) > ($${filters + 1}::text collate "C", $${filters + 2}::uuid))
       order by c.code collate "C", c.id
       limit $${filters + 3}`,
      [...params, after?.c ?? null, after?.i ?? null, take],
    );
    return rows.map((row) => ({ ...row, favourite }));
  };

  const result: CodeList = { rows: [], nextCursor: null };
  const more = (p: Cursor['p'], last: { code: string; id: string } | undefined) =>
    last ? encodeCursor({ p, c: last.code, i: last.id }) : null;

  if (from === undefined || from.p === 'f') {
    const favourites = await read(true, from ?? null, limit + 1);
    result.rows = favourites.slice(0, limit);
    if (favourites.length > limit) {
      result.nextCursor = more('f', result.rows.at(-1));
    } else if (!favouritesOnly) {
      // The favourites end on this page: the other codes follow, from their start.
      const room = limit - result.rows.length;
      const others = await read(false, null, room + 1);
      result.rows.push(...others.slice(0, room));
      if (others.length > room) {
        result.nextCursor =
          room > 0 ? more('n', result.rows.at(-1)) : encodeCursor({ p: 'n', ...START });
      }
    }
  } else {
    const others = favouritesOnly ? [] : await read(false, from, limit + 1);
    result.rows = others.slice(0, limit);
    if (others.length > limit) result.nextCursor = more('n', result.rows.at(-1));
  }

  if (from === undefined) {
    const count = await client.query<{ total: number }>(
      `select count(*)::int as total from codes c
       where ${where.join(' and ')}${favouritesOnly ? ` and ${FAVOURITE}` : ''}`,
      params,
    );
    result.total = count.rows[0]?.total ?? 0;
  }
  return result;
}

/** The code, or null when there is none such. */
export async function findCode(client: pg.ClientBase, id: string): Promise<CodeRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<CodeRow>(
    'select id, system, code, title from codes where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Marks a code as the hospital's favourite. False when it already is: nothing is written. */
export async function addFavourite(client: pg.ClientBase, codeId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `insert into code_favourites (tenant_id, code_id) values (app_tenant_id(), $1)
     on conflict do nothing`,
    [codeId],
  );
  return rowCount === 1;
}

/** Takes the mark away. False when there was none: nothing is written. */
export async function removeFavourite(client: pg.ClientBase, codeId: string): Promise<boolean> {
  const { rowCount } = await client.query('delete from code_favourites where code_id = $1', [
    codeId,
  ]);
  return rowCount === 1;
}

/**
 * For recording a diagnosis: an ICD-10 code by id, as it reads now, or null for any other id.
 * Exported from `index.ts`, so the clinical module never reads this table itself.
 */
export async function diagnosisCode(
  client: pg.ClientBase,
  id: string,
): Promise<{ id: string; code: string; title: string } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await client.query<{ id: string; code: string; title: string }>(
    "select id, code, title from codes where id = $1 and system = 'icd10'",
    [id],
  );
  return rows[0] ?? null;
}
