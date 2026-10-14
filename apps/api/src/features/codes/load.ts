import { createHash } from 'node:crypto';
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

export interface CheckedCode {
  /** The line of the file it is on. */
  line: number;
  code: string;
  title: string;
}

/**
 * The text of a code file from its bytes. The file must be UTF-8: read as anything else, a title
 * with an accent in it would be stored damaged and the load would still say it went well. A
 * spreadsheet's plain "CSV" on Windows is not UTF-8; its "CSV UTF-8" is.
 */
export function decodeCodeFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CodeFileError('the file is not UTF-8 text');
  }
}

/** The SHA-256 of a file, as `code_loads` records it: of its bytes, before they are read as text. */
export const fileSha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A code as the search compares it: `E11.9`, `e11.9` and `E119` are one code. */
const plainCode = (code: string) => code.toLowerCase().replaceAll('.', '');

/** The codes of a file, checked and tidied. Throws a `CodeFileError` naming the first bad line. */
export function checkedCodes(text: string): CheckedCode[] {
  const seen = new Map<string, number>();
  return parseCodeFile(text).map(({ line, code: written, title: typed }) => {
    const code = written.trim();
    if (!CODE.test(code) || code.length > CODE_MAX) {
      throw new CodeFileError('the code is not letters, digits, dots and dashes, at most 20', line);
    }
    // The replacement character is what is left of text that was once read in the wrong encoding.
    if (!plain.test(typed) || typed.includes('�')) {
      throw new CodeFileError('the title has a character that is not text', line);
    }
    const title = tidy(typed);
    if (title === '' || [...title].length > TITLE_MAX) {
      throw new CodeFileError('the title is empty or longer than 300 characters', line);
    }
    // One code however it is written: a set never holds A09 and a09, or E11.9 and E119.
    const first = seen.get(plainCode(code));
    if (first !== undefined) {
      throw new CodeFileError(`the code is also on line ${first}`, line);
    }
    seen.set(plainCode(code), line);
    return { line, code, title };
  });
}

/**
 * Writes the codes of a file into a set, and records the load in `code_loads` (which set, the
 * file's SHA-256, the counts, when and as which login), in the caller's transaction: a load that
 * is rolled back, as a dry run is, leaves no record. Runs as whoever owns the connection: the app
 * role cannot write codes, so this is never reachable from a request.
 */
export async function loadCodes(
  client: pg.ClientBase,
  system: CodeSystem,
  text: string,
  sha256: string,
): Promise<LoadResult> {
  const codes = checkedCodes(text);
  const batches: CheckedCode[][] = [];
  for (let start = 0; start < codes.length; start += BATCH) {
    batches.push(codes.slice(start, start + BATCH));
  }

  // A code the set already holds written another way (other capitals, or without its dot) would
  // become a second code that nothing could ever remove. Refused before anything is written.
  for (const batch of batches) {
    const { rows } = await client.query<{ code: string }>(
      `select written.code from unnest($2::text[]) as written (code)
       join codes c on c.system = $1 and c.code_plain = lower(replace(written.code, '.', ''))
       where c.code <> written.code
       limit 1`,
      [system, batch.map((each) => each.code)],
    );
    const clash = batch.find((each) => each.code === rows[0]?.code);
    if (clash) {
      throw new CodeFileError('the set already holds this code, written another way', clash.line);
    }
  }

  const result: LoadResult = { read: codes.length, added: 0, retitled: 0, unchanged: 0 };
  for (const batch of batches) {
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
  await client.query(
    `insert into code_loads (system, file_sha256, read, added, retitled, unchanged)
     values ($1, $2, $3, $4, $5, $6)`,
    [system, sha256, result.read, result.added, result.retitled, result.unchanged],
  );
  return result;
}
