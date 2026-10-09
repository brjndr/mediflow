import { Type, type Static } from '@sinclair/typebox';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The one error body every route returns. `code` is stable and machine-readable: the web app
 * maps it to a translated message. `message` is for developers and logs and is never shown to
 * users, so it must not carry patient data either.
 */
export const ErrorBody = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Stable machine-readable code, e.g. tenant_mismatch' }),
      message: Type.String(),
      requestId: Type.Optional(Type.String()),
    }),
  },
  { $id: 'Error', description: 'Standard error body.' },
);
export type ErrorBody = Static<typeof ErrorBody>;

/** Throw this from a route or hook to answer with a specific status and code. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
) {
  const body: ErrorBody = { error: { code, message, requestId: request.id } };
  return reply.status(status).send(body);
}

/** Registers the error and not-found handlers, and puts the request id on every response. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, request, 404, 'not_found', 'No such route'),
  );

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      return send(reply, request, error.statusCode, error.code, error.message);
    }
    if (error.validation) {
      // Says which part of the request failed, not what was sent.
      return send(
        reply,
        request,
        400,
        'validation_failed',
        `Invalid ${error.validationContext ?? 'request'}`,
      );
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Fastify's own client errors (malformed JSON, payload too large, unsupported media type).
      return send(reply, request, status, 'bad_request', 'The request could not be processed');
    }
    // An unexpected failure. The cause goes to the log (type and stack only); the client learns
    // nothing about internals.
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, 500, 'internal', 'Internal server error');
  });
}
