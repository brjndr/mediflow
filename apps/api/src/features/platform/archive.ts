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

/** A tar archive written in memory, entry by entry (ustar, names up to 100 bytes). */
export class TarBuilder {
  private readonly chunks: Buffer[] = [];
  private total = 0;

  get bytes(): number {
    return this.total;
  }

  add(name: string, data: Buffer): void {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length === 0 || nameBytes.length > 100) throw new Error('tar_name_too_long');
    const header = Buffer.alloc(512);
    nameBytes.copy(header, 0);
    header.write(octal(0o644, 8), 100, 'ascii'); // mode
    header.write(octal(0, 8), 108, 'ascii'); // uid
    header.write(octal(0, 8), 116, 'ascii'); // gid
    header.write(octal(data.length, 12), 124, 'ascii');
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
    header.write('        ', 148, 'ascii'); // the checksum, counted as blanks
    header.write('0', 156, 'ascii'); // a regular file
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    this.chunks.push(header, data, padding);
    this.total += header.length + data.length + padding.length;
  }

  /** The archive, ended with the two empty blocks the format asks for. */
  finish(): Buffer {
    return Buffer.concat([...this.chunks, Buffer.alloc(1024)]);
  }
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
