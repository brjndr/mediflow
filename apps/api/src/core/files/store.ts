import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Where files made by the API are kept (report exports), behind an interface so object storage
 * (S3 or anything that speaks it) can replace the local folder as a configuration change.
 *
 * A key is a relative path of lower-case letters, digits and `/ _ . -`, with no `..`.
 */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  /** The file, or null when there is none. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the file. Removing one that is not there is not an error. */
  delete(key: string): Promise<void>;
  /**
   * A time-limited address the provider serves itself, when it has such a thing (an S3 presigned
   * URL). The local store has none: the API serves its files from a route that checks a signature
   * (`core/files/signing.ts`).
   */
  presign?(key: string, ttlSeconds: number): Promise<string>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,199}$/;

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) {
    throw new Error('invalid_file_key');
  }
}

/** A folder on the API's own disk. Fine for development and one container; not for several. */
export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private locate(key: string): string {
    assertKey(key);
    const target = path.resolve(this.root, key);
    // Belt and braces: a key that passed the pattern still must not leave the folder.
    if (!target.startsWith(this.root + path.sep)) throw new Error('invalid_file_key');
    return target;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.locate(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Written beside the target and renamed, so a reader never sees half a file.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.locate(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.locate(key), { force: true });
  }
}
