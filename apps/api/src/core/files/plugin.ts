import fp from 'fastify-plugin';
import { LocalFileStore, type FileStore } from './store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Where the API keeps files it makes: a local folder now, object storage later. */
    files: FileStore;
  }
}

export const filesPlugin = fp<{ store?: FileStore }>(
  async (app, options) => {
    app.decorate('files', options.store ?? new LocalFileStore(app.config.FILE_STORE_DIR));
  },
  { name: 'files' },
);
