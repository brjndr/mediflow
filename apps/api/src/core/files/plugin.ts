import fp from 'fastify-plugin';
import { ClamAvScanner } from './clamav.js';
import { TestSignatureScanner, type MalwareScanner } from './scanner.js';
import { S3FileStore } from './s3-store.js';
import { LocalFileStore, type FileStore } from './store.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Where the API keeps files it makes: a local folder or an S3 bucket (`FILE_STORE`). */
    files: FileStore;
    /** What checks an uploaded file for malware before it can be downloaded. */
    scanner: MalwareScanner;
  }
}

export const filesPlugin = fp<{ store?: FileStore; scanner?: MalwareScanner }>(
  async (app, options) => {
    const { config } = app;
    const store =
      options.store ??
      (config.FILE_STORE === 's3'
        ? new S3FileStore({
            bucket: config.S3_BUCKET!,
            region: config.S3_REGION!,
            endpoint: config.S3_ENDPOINT,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION,
          })
        : new LocalFileStore(config.FILE_STORE_DIR));
    app.decorate('files', store);
    if (store instanceof S3FileStore) app.addHook('onClose', async () => store.close());
    const scanner =
      options.scanner ??
      (config.MALWARE_SCANNER === 'clamav'
        ? new ClamAvScanner({
            host: config.CLAMAV_HOST!,
            port: config.CLAMAV_PORT,
            timeoutMs: config.CLAMAV_TIMEOUT_MS,
          })
        : new TestSignatureScanner());
    if (scanner instanceof TestSignatureScanner && config.NODE_ENV === 'production') {
      app.log.warn({ event: 'test_scanner_in_use' }, 'MALWARE_SCANNER=test is not protection');
    }
    app.decorate('scanner', scanner);
  },
  { name: 'files' },
);
