/**
 * Comma-separated text as a spreadsheet exports it, read in the browser: the staff invitations
 * and the import centre. A file is held in memory only, never stored.
 */

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
