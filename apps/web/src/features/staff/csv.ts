import { EMAIL, EMAIL_MAX, NAME_MAX } from './schemas';
import type { InviteRequest, StaffRole } from './types';

/** How many people one file may invite. More is a job for several files. */
export const MAX_ROWS = 200;
/** Far more than 200 rows of names and addresses need. */
export const MAX_FILE_BYTES = 200_000;

/** Why a file cannot be used at all, as a key of this feature's strings. */
export type FileProblem =
  'bulk.file.empty' | 'bulk.file.header' | 'bulk.file.tooMany' | 'bulk.file.tooLarge';

/** Why one row cannot be sent, as a key of this feature's strings. */
export type RowProblem =
  | 'bulk.problems.name'
  | 'bulk.problems.email'
  | 'bulk.problems.role'
  | 'bulk.problems.roleAmbiguous'
  | 'bulk.problems.duplicate';

export interface BulkRow {
  /** The line of the file the row starts on, counting from 1, so a person can find it. */
  line: number;
  name: string;
  email: string;
  /** The role as the hospital names it when the file's text was understood, else the text. */
  role: string;
  /** What to send. Absent when the row has a problem. */
  request?: InviteRequest;
  problem?: RowProblem;
}

export interface CsvRow {
  /** The line of the text the row starts on, counting from 1. */
  line: number;
  fields: string[];
}

const SEPARATORS = [',', ';', '\t'] as const;

/** `sep=;` on a line of its own is how a spreadsheet says which separator a file uses. */
const DECLARED = /^sep=(.)\r?\n/i;

/**
 * Which character separates the fields: the one the file declares, or the one its first line
 * uses most. A spreadsheet set to a European locale exports semicolons.
 */
function separatorOf(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = SEPARATORS.map((separator) => firstLine.split(separator).length - 1);
  return SEPARATORS[counts.indexOf(Math.max(...counts))] ?? ',';
}

/**
 * Splits CSV text into rows of fields: quoted fields with doubled quotes and line breaks inside
 * them, and any kind of line ending. Blank lines are left out, and each row knows the line it
 * started on. A quote that is never closed takes the rest of the file into its field, which the
 * row checks then refuse.
 */
export function parseCsv(input: string): CsvRow[] {
  // A byte-order mark is what a spreadsheet puts at the start of an exported file.
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let line = 1;
  let separator: string;
  const declared = DECLARED.exec(text);
  if (declared) {
    separator = declared[1] ?? ',';
    text = text.slice(declared[0].length);
    line = 2;
  } else {
    separator = separatorOf(text);
  }

  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let startedOn = line;
  const endField = () => {
    fields.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (fields.some((value) => value !== '')) rows.push({ line: startedOn, fields });
    fields = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') line++;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.trim() === '') quoted = true;
    else if (char === separator) endField();
    else if (char === '\n') {
      endRow();
      startedOn = line;
    } else if (char !== '\r') field += char;
  }
  endRow();
  return rows;
}

const COLUMNS = ['name', 'email', 'role'] as const;

/**
 * The role a file's text means: its id if a role has that id, else the one role with that name.
 * A name that two roles share, or that is also another role's id, is not guessed at.
 */
function roleFor(text: string, roles: StaffRole[]): StaffRole | 'none' | 'ambiguous' {
  const wanted = text.toLowerCase();
  const byId = roles.filter((role) => role.id.toLowerCase() === wanted);
  const byName = roles.filter((role) => role.name.toLowerCase() === wanted);
  const matches = [...new Set([...byId, ...byName])];
  if (matches.length === 0) return 'none';
  return matches.length === 1 ? (matches[0] as StaffRole) : 'ambiguous';
}

/**
 * Turns a file into the people to invite. The first row names the columns (name, email, role, in
 * any order); a role is given by its name or its id. Every row is kept, with what is wrong with
 * it, so the person sees the whole file and can fix it.
 */
export function readInvites(
  text: string,
  roles: StaffRole[],
): { rows: BulkRow[] } | { problem: FileProblem } {
  const [header, ...lines] = parseCsv(text);
  if (!header) return { problem: 'bulk.file.empty' };
  const titles = header.fields.map((title) => title.toLowerCase());
  const at = Object.fromEntries(COLUMNS.map((column) => [column, titles.indexOf(column)]));
  if (COLUMNS.some((column) => (at[column] ?? -1) < 0)) return { problem: 'bulk.file.header' };
  if (lines.length === 0) return { problem: 'bulk.file.empty' };
  if (lines.length > MAX_ROWS) return { problem: 'bulk.file.tooMany' };

  const seen = new Set<string>();
  const rows = lines.map(({ line, fields }): BulkRow => {
    const value = (column: (typeof COLUMNS)[number]) => fields[at[column] ?? -1] ?? '';
    const name = value('name');
    const email = value('email').toLowerCase();
    const found = roleFor(value('role'), roles);
    // What will be sent is what is shown: the role as the hospital names it, once it is known.
    const row = { line, name, email, role: typeof found === 'string' ? value('role') : found.name };
    if (name === '' || name.length > NAME_MAX) return { ...row, problem: 'bulk.problems.name' };
    if (!EMAIL.test(email) || email.length > EMAIL_MAX) {
      return { ...row, problem: 'bulk.problems.email' };
    }
    if (found === 'none') return { ...row, problem: 'bulk.problems.role' };
    if (found === 'ambiguous') return { ...row, problem: 'bulk.problems.roleAmbiguous' };
    if (seen.has(email)) return { ...row, problem: 'bulk.problems.duplicate' };
    seen.add(email);
    return { ...row, request: { name, email, roleId: found.id } };
  });
  return { rows };
}
