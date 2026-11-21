import type { Cell, ReportResult } from './schemas.js';

/**
 * A text cell a spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return) is given a leading quote, so a department or drug named to attack the person
 * who opens the export does nothing. Numbers are never touched: a negative one is a number.
 */
function text(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const cell = (value: Cell, type: string): string => {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  return type === 'date' ? value : text(value);
};

/**
 * The report as CSV with a byte order mark (a `preamble` of lines goes above the header, then a
 * blank line), so Excel reads names in any script as UTF-8. */
export function toCsv(result: ReportResult, preamble: Cell[][] = []): Buffer {
  const typeAt = (index: number) => result.columns[index]?.type ?? 'text';
  const lines = [
    ...(preamble.length > 0
      ? [...preamble.map((line) => line.map((value) => cell(value, 'text')).join(',')), '']
      : []),
    result.columns.map((column) => column.key).join(','),
    ...result.rows.map((row) => row.map((value, index) => cell(value, typeAt(index))).join(',')),
  ];
  if (result.totals.some((total) => total !== null)) {
    lines.push(
      result.totals
        .map((total, index) =>
          index === 0 && total === null ? 'total' : cell(total, typeAt(index)),
        )
        .join(','),
    );
  }
  const bom = '\u{FEFF}';
  return Buffer.from(`${bom}${lines.join('\r\n')}\r\n`, 'utf8');
}
