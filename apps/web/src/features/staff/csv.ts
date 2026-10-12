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
  'bulk.problems.name' | 'bulk.problems.email' | 'bulk.problems.role' | 'bulk.problems.duplicate';

export interface BulkRow {
  /** The line of the file, counting the header as 1, so a person can find it. */
  line: number;
  name: string;
  email: string;
  /** The role as written in the file. */
  role: string;
  /** What to send. Absent when the row has a problem. */
  request?: InviteRequest;
  problem?: RowProblem;
}

/**
 * Splits CSV text into rows of fields: commas, quoted fields with doubled quotes, and any kind of
 * line ending. Blank lines are left out.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  // A byte-order mark is what a spreadsheet puts at the start of an exported file.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.trim() === '') quoted = true;
    else if (char === ',') endField();
    else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  endRow();
  return rows;
}

const COLUMNS = ['name', 'email', 'role'] as const;

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
  const titles = header.map((title) => title.toLowerCase());
  const at = Object.fromEntries(COLUMNS.map((column) => [column, titles.indexOf(column)]));
  if (COLUMNS.some((column) => (at[column] ?? -1) < 0)) return { problem: 'bulk.file.header' };
  if (lines.length === 0) return { problem: 'bulk.file.empty' };
  if (lines.length > MAX_ROWS) return { problem: 'bulk.file.tooMany' };

  const seen = new Set<string>();
  const rows = lines.map((fields, index): BulkRow => {
    const value = (column: (typeof COLUMNS)[number]) => fields[at[column] ?? -1] ?? '';
    const name = value('name');
    const email = value('email').toLowerCase();
    const role = value('role');
    const known = roles.find(
      (candidate) =>
        candidate.id.toLowerCase() === role.toLowerCase() ||
        candidate.name.toLowerCase() === role.toLowerCase(),
    );
    const row = { line: index + 2, name, email, role };
    if (name === '' || name.length > NAME_MAX) return { ...row, problem: 'bulk.problems.name' };
    if (!EMAIL.test(email) || email.length > EMAIL_MAX) {
      return { ...row, problem: 'bulk.problems.email' };
    }
    if (!known) return { ...row, problem: 'bulk.problems.role' };
    if (seen.has(email)) return { ...row, problem: 'bulk.problems.duplicate' };
    seen.add(email);
    return { ...row, request: { name, email, roleId: known.id } };
  });
  return { rows };
}
