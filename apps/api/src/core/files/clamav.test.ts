import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, parseReply } from './clamav.js';

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A stand-in for clamd: reads INSTREAM to its zero chunk, then sends `answer`. */
async function fakeDaemon(answer: (received: Buffer) => string | null) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.subarray(-4).equals(Buffer.alloc(4))) {
        const reply = answer(buffer);
        if (reply === null) socket.destroy();
        else socket.end(`${reply}\0`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

describe('parseReply', () => {
  it('reads a verdict and refuses anything else', () => {
    expect(parseReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
    expect(() => parseReply('INSTREAM size limit exceeded. ERROR')).toThrow('clamav_error');
    expect(() => parseReply('')).toThrow('clamav_error');
  });
});

describe('ClamAvScanner', () => {
  const scanner = (port: number) => new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 2000 });

  it('streams the file with its length and returns the verdict', async () => {
    const data = Buffer.alloc(200_000, 7);
    let seen: Buffer = Buffer.alloc(0);
    const port = await fakeDaemon((received) => {
      seen = received;
      return 'stream: OK';
    });
    expect(await scanner(port).scan(data)).toEqual({ clean: true });
    expect(seen.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(seen.length).toBe(10 + 3 * 4 + data.length + 4);
    expect(seen.readUInt32BE(10)).toBe(64 * 1024);
  });

  it('reports what was found', async () => {
    const port = await fakeDaemon(() => 'stream: Win.Test.EICAR_HDB-1 FOUND');
    expect(await scanner(port).scan(Buffer.from('x'))).toEqual({
      clean: false,
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('throws, so the job is retried, when the daemon errs, drops or is not there', async () => {
    const erring = await fakeDaemon(() => 'INSTREAM size limit exceeded. ERROR');
    await expect(scanner(erring).scan(Buffer.from('x'))).rejects.toThrow('clamav_error');
    const dropping = await fakeDaemon(() => null);
    await expect(scanner(dropping).scan(Buffer.from('x'))).rejects.toThrow();
    const free = await fakeDaemon(() => 'stream: OK');
    servers.splice(0).forEach((server) => server.close());
    await expect(scanner(free).scan(Buffer.from('x'))).rejects.toThrow('clamav_unreachable');
  });
});
