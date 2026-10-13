/**
 * Reads a code file: comma-separated text with a first line naming its two columns, `code` and
 * `title`. A value with a comma, a quote or a line break in it is quoted, and a quote inside is
 * written twice, as spreadsheets write them.
 *
 *   code,title
 *   A09,"Infectious gastroenteritis and colitis, unspecified"
 */

export interface CodeLine {
  /** The line of the file it started on, for a message about it. */
  line: number;
  code: string;
  title: string;
}

export class CodeFileError extends Error {
  constructor(
    message: string,
    /** The line of the file the problem is on, when it is on one. */
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'CodeFileError';
  }
}

/** The rows of comma-separated text, each with the line it started on. */
function rows(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startedOn = 1;
  const endRow = () => {
    cells.push(cell);
    // A line with nothing on it is not a row.
    if (cells.length > 1 || cells[0] !== '') out.push({ line: startedOn, cells });
    cells = [];
    cell = '';
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') {
          cell += '"';
          at++;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line++;
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      endRow();
      line++;
      startedOn = line;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CodeFileError('a quoted value is not closed', startedOn);
  endRow();
  return out;
}

/** The codes of a file, as written. Throws a `CodeFileError` that says where the file is wrong. */
export function parseCodeFile(text: string): CodeLine[] {
  // A file saved by a spreadsheet may start with a byte order mark.
  const [header, ...lines] = rows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!header) throw new CodeFileError('the file is empty');
  const names = header.cells.map((name) => name.trim().toLowerCase());
  if (names.length !== 2 || names[0] !== 'code' || names[1] !== 'title') {
    throw new CodeFileError('the first line must be: code,title', header.line);
  }
  return lines.map(({ line, cells }) => {
    if (cells.length !== 2) {
      throw new CodeFileError(`expected a code and a title, found ${cells.length} values`, line);
    }
    return { line, code: cells[0] ?? '', title: cells[1] ?? '' };
  });
}
