import { parseCsv, type CsvRow } from '@/shared/utils/csv';
import { MAX_FILE_BYTES, MAX_ROWS, VALUE_MAX } from './schemas';

/** Why a file cannot be used at all, as a key of this feature's strings. */
export type FileProblem =
  | 'file.tooLarge'
  | 'file.empty'
  | 'file.noRows'
  | 'file.tooMany'
  | 'file.longValue'
  | 'file.encoding'
  | 'file.unreadable';

export interface ReadFile {
  /** The titles of the columns: the first row of the file. */
  headers: string[];
  rows: CsvRow[];
}

/** The rows of a file's text, in a worker where the browser has one. */
function parse(text: string): Promise<CsvRow[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(parseCsv(text));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./read.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<CsvRow[]>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('unreadable'));
    };
    worker.postMessage(text);
  });
}

/**
 * Reads a CSV file chosen on this device. It is held in memory only, for as long as the screen
 * is open, and never stored in the browser.
 */
export async function readCsvFile(file: File): Promise<ReadFile | { problem: FileProblem }> {
  if (file.size > MAX_FILE_BYTES) return { problem: 'file.tooLarge' };
  let text: string;
  let rows: CsvRow[];
  try {
    text = await file.text();
    // A file saved in another encoding (a spreadsheet's "CSV" on Windows) reads with its accents
    // replaced: refused, rather than names written damaged.
    if (text.includes('\uFFFD')) return { problem: 'file.encoding' };
    rows = await parse(text);
  } catch {
    return { problem: 'file.unreadable' };
  }
  const [header, ...lines] = rows;
  if (!header) return { problem: 'file.empty' };
  if (lines.length === 0) return { problem: 'file.noRows' };
  if (lines.length > MAX_ROWS) return { problem: 'file.tooMany' };
  if (lines.some((line) => line.fields.some((field) => field.length > VALUE_MAX))) {
    return { problem: 'file.longValue' };
  }
  return { headers: header.fields, rows: lines };
}
