import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

/**
 * No request carries a NUL character (U+0000) in its text.
 *
 * Postgres cannot store a NUL in text, so a NUL that reached a query was refused by the database
 * and answered as a 500 (#1183: ZAP's API scan found one in the email of the forgot-password
 * route). `PLAIN_TEXT` already refuses it in the fields that use the pattern, but a token, an
 * email, an id or a search term does not use it. This hook runs before validation on every route
 * and refuses (400 `validation_failed`) a NUL in any text of the body, the query string or the
 * path parameters, and in the name of a body field. Nobody types a NUL, so this is the one
 * character a search term is refused for rather than tidied away.
 */

const NUL = '\u0000';

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) ||
  (typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));

/**
 * Whether a value, at any depth, holds a NUL in a text or in a field name. Only plain objects
 * and arrays are looked into (a Buffer or a stream is not text), and without recursion, so a
 * deeply nested body cannot exhaust the stack.
 */
export function holdsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (next.includes(NUL)) return true;
    } else if (Array.isArray(next)) {
      // One at a time: spreading a long array into push() can exceed the argument limit.
      for (const item of next) pending.push(item);
    } else if (isContainer(next)) {
      for (const [key, item] of Object.entries(next)) {
        if (key.includes(NUL)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

/** Registers the check for every route. Call it before any route. */
export function registerNoNul(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    // The router and the query parser make their objects with a prototype of their own, so their
    // fields are copied into a plain object to be looked into.
    for (const [part, value] of [
      ['path', { ...(request.params as object) }],
      ['query', { ...(request.query as object) }],
      ['body', request.body],
    ] as const) {
      if (holdsNul(value)) {
        // Which part, never the value: it may be anything, a patient's name included.
        throw new HttpError(400, 'validation_failed', `The ${part} holds a NUL character`);
      }
    }
  });
}
