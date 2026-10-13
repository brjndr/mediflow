import type { FastifyInstance } from 'fastify';

/** Nothing may keep the answer: not a shared cache, and not the browser that asked. */
export const NO_STORE = 'private, no-store';

/**
 * Every answer says it is not to be stored, unless its route said something else on purpose (the
 * access policy is `private, no-cache` with an ETag, so a refresh is cheap). A patient record read
 * on a shared hospital PC must not be readable from the browser's cache after sign-out, and no
 * feature has to remember that. Errors and public routes get it too: nothing the API answers is
 * meant to be kept.
 *
 * A route's own header counts for its answer only, never for a refusal: a handler that set one and
 * then failed is answered as any error is, and without the ETag of what it did not send.
 */
export function registerCacheDefault(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    if (reply.statusCode >= 400) {
      reply.removeHeader('etag');
      reply.header('cache-control', NO_STORE);
    } else if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', NO_STORE);
    }
  });
}
