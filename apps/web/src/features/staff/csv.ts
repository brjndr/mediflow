import { parseCsv } from '@/shared/utils/csv';
import { EMAIL, EMAIL_MAX, NAME_MAX } from './schemas';
import type { InviteRequest, StaffRole } from './types';

// The tests of the reader are with the file it was first written for.
export { parseCsv };

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
