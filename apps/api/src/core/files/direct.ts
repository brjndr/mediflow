import type { FastifyInstance } from 'fastify';

/**
 * Whether the browser is given the bucket's own presigned addresses (`S3_DIRECT_LINKS`, #765).
 * The caller has already checked the hospital, the permission and the scan status.
 */
export const directLinks = (app: FastifyInstance): boolean =>
  app.config.S3_DIRECT_LINKS && typeof app.files.presign === 'function';
