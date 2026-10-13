import type pg from 'pg';
import { PLAIN_TEXT, tidy } from '../../core/http/text.js';
import { CodeFileError, parseCodeFile } from './csv.js';
import { CODE_MAX, TITLE_MAX, type CodeSystem } from './schemas.js';

/**
 * Loads a code set from a file an operator supplies. No code set is kept in the repository: which
 * edition a hospital uses is its own to license (ICD-10 as the WHO publishes it is not free to
 * ship in software).
 *
 * A set is loaded again by adding the codes it has gained and changing the titles that changed.
 * Nothing is ever removed: a diagnosis recorded with a code, and a hospital's favourite, still
 * name it. The whole file is checked before anything is written, and it is written in the
 * caller's transaction, so a file with a mistake in it changes nothing.
 */

const CODE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const plain = new RegExp(PLAIN_TEXT, 'u');
/** How many codes one statement writes. */
const BATCH = 1000;

export interface LoadResult {
  /** Codes in the file. */
  read: number;
  added: number;
  /** Codes whose title changed. */
  retitled: number;
  unchanged: number;
}

/** The codes of a file, checked and tidied. Throws a `CodeFileError` naming the first bad line. */
export function checkedCodes(text: string): { code: string; title: string }[] {
  const seen = new Map<string, number>();
  return parseCodeFile(text).map(({ line, code: written, title: typed }) => {
    const code = written.trim();
    if (!CODE.test(code) || code.length > CODE_MAX) {
      throw new CodeFileError('the code is not letters, digits, dots and dashes, at most 20', line);
    }
    if (!plain.test(typed))
      throw new CodeFileError('the title has a character that is not text', line);
    const title = tidy(typed);
    if (title === '' || [...title].length > TITLE_MAX) {
      throw new CodeFileError('the title is empty or longer than 300 characters', line);
    }
    const first = seen.get(code);
    if (first !== undefined) {
      throw new CodeFileError(`the code ${code} is also on line ${first}`, line);
    }
    seen.set(code, line);
    return { code, title };
  });
}

/**
 * Writes the codes of a file into a set. Runs as whoever owns the connection: the app role
 * cannot write codes, so this is never reachable from a request.
 */
export async function loadCodes(
  client: pg.ClientBase,
  system: CodeSystem,
  text: string,
): Promise<LoadResult> {
  const codes = checkedCodes(text);
  const result: LoadResult = { read: codes.length, added: 0, retitled: 0, unchanged: 0 };
  for (let start = 0; start < codes.length; start += BATCH) {
    const batch = codes.slice(start, start + BATCH);
    const { rows } = await client.query<{ added: boolean }>(
      `insert into codes (system, code, title)
       select $1, code, title from unnest($2::text[], $3::text[]) as written (code, title)
       on conflict on constraint codes_system_code do update
         set title = excluded.title, updated_at = now()
         where codes.title <> excluded.title
       returning (xmax = 0) as added`,
      [system, batch.map((each) => each.code), batch.map((each) => each.title)],
    );
    const added = rows.filter((row) => row.added).length;
    result.added += added;
    result.retitled += rows.length - added;
  }
  result.unchanged = result.read - result.added - result.retitled;
  return result;
}
