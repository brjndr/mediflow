import fp from 'fastify-plugin';
import { TestSignatureScanner, type MalwareScanner } from './scanner.js';
import { LocalFileStore, type FileStore } from './store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Where the API keeps files it makes: a local folder now, object storage later. */
    files: FileStore;
    /** What checks an uploaded file for malware before it can be downloaded. */
    scanner: MalwareScanner;
  }
}

export const filesPlugin = fp<{ store?: FileStore; scanner?: MalwareScanner }>(
  async (app, options) => {
    app.decorate('files', options.store ?? new LocalFileStore(app.config.FILE_STORE_DIR));
    app.decorate('scanner', options.scanner ?? new TestSignatureScanner());
  },
  { name: 'files' },
);
