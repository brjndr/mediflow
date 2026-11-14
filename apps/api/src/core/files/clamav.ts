import net from 'node:net';
import type { MalwareScanner } from './scanner.js';

export interface ClamAvOptions {
  host: string;
  port: number;
  /** Gives up on a connection that says nothing for this long. */
  timeoutMs: number;
}

const CHUNK = 64 * 1024;

/**
 * A ClamAV daemon (`clamd`) over TCP, using its INSTREAM command: the file is streamed to the
 * daemon in length-prefixed chunks and never written to its disk. The daemon needs
 * `StreamMaxLength` at least as large as the biggest upload (100 MB for imaging).
 *
 * A reply that is not a verdict (the daemon down, a size limit, an error) throws, so the scan job
 * fails and is retried while the file stays held: an unscanned file is never released.
 */
export class ClamAvScanner implements MalwareScanner {
  constructor(private readonly options: ClamAvOptions) {}

  scan(data: Buffer): Promise<{ clean: true } | { clean: false; signature: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.options.host, port: this.options.port });
      const reply: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null, verdict?: ReturnType<typeof parseReply>) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(verdict!);
      };
      socket.setTimeout(this.options.timeoutMs, () => finish(new Error('clamav_timeout')));
      socket.on('error', () => finish(new Error('clamav_unreachable')));
      socket.on('data', (chunk) => reply.push(chunk));
      socket.on('end', () => {
        try {
          finish(null, parseReply(Buffer.concat(reply).toString('utf8')));
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += CHUNK) {
          const part = data.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** `stream: OK`, `stream: <name> FOUND`, or an error, which throws. */
export function parseReply(text: string): { clean: true } | { clean: false; signature: string } {
  const line = text.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(line)) return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found) return { clean: false, signature: found[1]! };
  throw new Error('clamav_error');
}
