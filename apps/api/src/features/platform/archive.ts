import { createHash } from 'node:crypto';

/** A value of a row (read as JSON) in a CSV cell: null is empty, an object is its JSON. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvLine = (values: readonly unknown[]): string => `${values.map(cell).join(',')}\r\n`;

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, '0')}\0`;

/** The 512-byte header of one tar entry (ustar, names up to 100 bytes). */
export function tarHeader(name: string, size: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length === 0 || nameBytes.length > 100) throw new Error('tar_name_too_long');
  const header = Buffer.alloc(512);
  nameBytes.copy(header, 0);
  header.write(octal(0o644, 8), 100, 'ascii'); // mode
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  header.write('        ', 148, 'ascii'); // the checksum, counted as blanks
  header.write('0', 156, 'ascii'); // a regular file
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** The two empty blocks that end an archive. */
export const TAR_END = Buffer.alloc(1024);

/** One entry as the chunks it is made of: header, data, padding to a whole block. */
export function tarEntry(name: string, data: Buffer): Buffer[] {
  return [tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
