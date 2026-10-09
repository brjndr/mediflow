/**
 * What may leave the browser in an error report.
 *
 * The outgoing event is rebuilt from an allowlist, never trimmed from the original. Anything not
 * named here is dropped, including fields a future SDK version adds. Deliberately absent:
 * request and response bodies, URLs and query strings, breadcrumbs (console output, clicked
 * elements, fetch URLs), the user, cookies and headers, and free-form "extra" data.
 *
 * Error messages are dropped too. A message is free text that code builds from data ("Cannot
 * render patient Jane Doe"), so it cannot be trusted to be free of patient data. The error type,
 * the stack trace, the route pattern and the tenant say where and what failed; the message of an
 * ApiError is kept because it is always one of a fixed set of codes.
 */

/** The parts of an SDK error event this module reads. Structural, so it has no SDK dependency. */
export interface OutgoingEvent {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  exception?: { values?: OutgoingException[] };
}

interface OutgoingException {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean };
  stacktrace?: { frames?: OutgoingFrame[] };
}

interface OutgoingFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

export interface ScrubContext {
  /** The declared route pattern, e.g. `/patients/:patientId`. Never the address. */
  route: string;
  tenantId: string | undefined;
}

export interface SafeEvent {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  environment?: string;
  release?: string;
  exception: { values: SafeException[] };
  tags: { route: string; tenantId?: string };
}

interface SafeException {
  type: string;
  value: string;
  mechanism?: { type?: string; handled?: boolean };
  stacktrace?: { frames: SafeFrame[] };
}

interface SafeFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

export const REDACTED = '[redacted]';

/** ApiError messages are codes such as `not_found`. Anything else under that type is not kept. */
const API_ERROR_CODE = /^[a-z_]{1,32}$/;
/** Error class names. A name that does not look like one is replaced, in case it is data. */
const TYPE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

function safeValue(exception: OutgoingException): string {
  const { type, value } = exception;
  return type === 'ApiError' && typeof value === 'string' && API_ERROR_CODE.test(value)
    ? value
    : REDACTED;
}

/** A script address without its query string or fragment, which could carry data. */
function safeFilename(filename: string | undefined): string | undefined {
  return typeof filename === 'string' ? filename.split(/[?#]/)[0] : undefined;
}

function safeFrame(frame: OutgoingFrame): SafeFrame {
  return {
    filename: safeFilename(frame.filename),
    function: typeof frame.function === 'string' ? frame.function : undefined,
    lineno: typeof frame.lineno === 'number' ? frame.lineno : undefined,
    colno: typeof frame.colno === 'number' ? frame.colno : undefined,
    in_app: typeof frame.in_app === 'boolean' ? frame.in_app : undefined,
  };
}

function safeException(exception: OutgoingException): SafeException {
  const type = exception.type;
  return {
    type: typeof type === 'string' && TYPE_NAME.test(type) ? type : 'Error',
    value: safeValue(exception),
    mechanism: exception.mechanism && {
      type: exception.mechanism.type,
      handled: exception.mechanism.handled,
    },
    stacktrace: exception.stacktrace?.frames && {
      frames: exception.stacktrace.frames.map(safeFrame),
    },
  };
}

/**
 * Rebuilds an error event with only the allowed fields. Returns null for anything that is not an
 * exception (a captured message, for instance), which is then not sent at all.
 */
export function scrubEvent(event: OutgoingEvent, context: ScrubContext): SafeEvent | null {
  const exceptions = event.exception?.values;
  if (!exceptions || exceptions.length === 0) return null;
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    exception: { values: exceptions.map(safeException) },
    tags: { route: context.route, ...(context.tenantId ? { tenantId: context.tenantId } : {}) },
  };
}
