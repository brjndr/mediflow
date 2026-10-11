import { Type } from '@sinclair/typebox';

/**
 * The request headers of a route with `config.idempotent`, for its `schema.headers`. The key is
 * optional unless the route sets `required`; the format is checked by the idempotency plugin.
 */
export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.Optional(
    Type.String({
      minLength: 8,
      maxLength: 128,
      description:
        'A unique value (such as a UUID) chosen by the client. Repeating the request with the same key returns the first result instead of doing the work again.',
    }),
  ),
});
