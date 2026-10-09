/**
 * The only way app code writes to the console. It exists so that patient data cannot be logged
 * by accident: a log entry is an event name plus a small set of named fields, and the set has no
 * place for a name, a phone number, a diagnosis or a whole record.
 *
 *   logger.warn('i18n.missing_key', { key });
 *   logger.error('notices.archive_failed', { code: error.code, status: error.status });
 *
 * To log something new, add a field to LogFields here, in review, where the question "can this
 * ever hold patient data?" gets asked once. Never pass an object, an error message or free text.
 */

/** Everything a log entry may carry. All of it is safe to appear in a console or a log store. */
export interface LogFields {
  /** Tenant id (not the hospital's name). */
  tenantId?: string;
  /** Declared route pattern, e.g. `/patients/:patientId`. Never the address. */
  route?: string;
  /** Feature id from its manifest. */
  feature?: string;
  /** A stable machine code, e.g. an ApiError code. */
  code?: string;
  /** HTTP status. */
  status?: number;
  /** Server request id, for correlating with backend logs. */
  requestId?: string;
  /** A translation key or other static key from source code. */
  key?: string;
  count?: number;
  durationMs?: number;
}

const ALLOWED = new Set<string>([
  'tenantId',
  'route',
  'feature',
  'code',
  'status',
  'requestId',
  'key',
  'count',
  'durationMs',
] satisfies (keyof LogFields)[]);

const EVENT_NAME = /^[a-z0-9]+([._][a-z0-9]+)*$/;
/** Field values are short tokens: ids, codes, keys, patterns. Not sentences. */
const TOKEN = /^[\w.:/*-]{1,128}$/;

/**
 * Types stop most mistakes at compile time. This is the runtime backstop for the rest (a cast,
 * a value from untyped code): unknown fields, non-primitive values and anything that is not a
 * short token are dropped, and an event name that is not a static identifier is replaced.
 */
export function sanitizeLog(
  event: string,
  fields: LogFields = {},
): { event: string; fields: Record<string, string | number> } {
  const safe: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!ALLOWED.has(name)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) safe[name] = value;
    else if (typeof value === 'string' && TOKEN.test(value)) safe[name] = value;
  }
  return { event: EVENT_NAME.test(event) ? event : 'invalid_event_name', fields: safe };
}

function write(level: 'warn' | 'error', event: string, fields?: LogFields): void {
  const entry = sanitizeLog(event, fields);
  // eslint-disable-next-line no-console -- the one place that may: everything here is sanitized
  console[level](entry.event, entry.fields);
}

export const logger = {
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};
