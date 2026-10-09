import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config/config.js';

/**
 * Logging rules (CLAUDE.md Backend and Security):
 * - Request and response bodies are never logged. Fastify does not log them and nothing here adds
 *   them.
 * - The logged URL is the path only. Query strings carry search terms such as a patient's name.
 * - Fields that can hold patient data or secrets are redacted wherever they appear, as a backstop
 *   for a developer logging an object by mistake.
 */

/** Keys that are never written to a log, whatever object they sit in. */
export const REDACTED_KEYS = [
  // Patient and staff identity
  'firstName',
  'lastName',
  'fullName',
  'name',
  'dob',
  'dateOfBirth',
  'gender',
  'phone',
  'email',
  'address',
  'mrn',
  // Clinical and financial content
  'diagnosis',
  'notes',
  'note',
  'body',
  'result',
  'prescription',
  // Secrets
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
] as const;

/** pino matches one wildcard level per `*`, so each key is listed at three depths. */
const REDACT_PATHS = REDACTED_KEYS.flatMap((key) => {
  const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const dotted = safe.startsWith('[') ? safe : `.${safe}`;
  return [safe.startsWith('[') ? safe : key, `*${dotted}`, `*.*${dotted}`];
});

/** The path without its query string. */
function pathOnly(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}

export function loggerOptions(
  config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>,
): NonNullable<Exclude<FastifyServerOptions['logger'], boolean>> {
  return {
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req: (request: { method?: string; url?: string; id?: string }) => ({
        method: request.method,
        url: pathOnly(request.url),
        requestId: request.id,
      }),
      res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      // Error messages are built from data, so only the type and the stack are kept.
      err: (error: { name?: string; code?: string; statusCode?: number; stack?: string }) => ({
        type: error.name ?? 'Error',
        message: '[redacted]',
        code: error.code,
        statusCode: error.statusCode,
        // The first line of a stack repeats the message, so it is dropped.
        stack: error.stack?.split('\n').slice(1).join('\n') ?? '',
      }),
    },
  };
}
