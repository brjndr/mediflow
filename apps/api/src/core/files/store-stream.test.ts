import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getStream, LocalFileStore, putStream, type FileStore } from './store.js';

const read = async (stream: Readable | null): Promise<string> => {
  if (!stream) throw new Error('no stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
};

describe('streaming through a file store', () => {
  let root: string;
  let store: LocalFileStore;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'files-stream-'));
    store = new LocalFileStore(root);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('writes a stream in pieces and reads it back as a stream', async () => {
    await putStream(
      store,
      'exports/h/a.tar',
      Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
    );
    expect((await store.get('exports/h/a.tar'))?.toString()).toBe('abcd');
    expect(await read(await getStream(store, 'exports/h/a.tar'))).toBe('abcd');
    expect(await store.size?.('exports/h/a.tar')).toBe(4);
    expect(await getStream(store, 'exports/h/none.tar')).toBeNull();
  });

  it('leaves no file, not even a temporary one, when the stream fails', async () => {
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from('half');
      throw new Error('boom');
    }
    await expect(putStream(store, 'exports/h/b.tar', Readable.from(broken()))).rejects.toThrow(
      'boom',
    );
    expect(await store.get('exports/h/b.tar')).toBeNull();
    expect(
      (await readdir(path.join(root, 'exports/h'))).filter((n) => n.includes('b.tar')),
    ).toEqual([]);
  });

  it('falls back to buffering for a store without streams', async () => {
    const kept = new Map<string, Buffer>();
    const plain: FileStore = {
      put: async (key, data) => void kept.set(key, data),
      get: async (key) => kept.get(key) ?? null,
      delete: async (key) => void kept.delete(key),
    };
    await putStream(plain, 'x/y', Readable.from([Buffer.from('12'), Buffer.from('34')]));
    expect(kept.get('x/y')?.toString()).toBe('1234');
    expect(await read(await getStream(plain, 'x/y'))).toBe('1234');
  });
});
