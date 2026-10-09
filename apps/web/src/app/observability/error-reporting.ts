import { scrubEvent, type ScrubContext } from './scrub';

/**
 * Error reporting. `reportError` can be called from anywhere at any time: until the reporter is
 * started it keeps a few errors in memory and sends them once it is, and if reporting is never
 * configured (no DSN, as in development and tests) they are simply dropped.
 */

type Capture = (error: unknown) => void;

const MAX_QUEUED = 20;
let queue: unknown[] = [];
let capture: Capture | undefined;

/** Report an error that the app caught itself (an error boundary, a failed background task). */
export function reportError(error: unknown): void {
  if (capture) capture(error);
  else if (queue.length < MAX_QUEUED) queue.push(error);
}

interface ErrorReportingOptions {
  /** Where to send reports. Without one, nothing is loaded and nothing is sent. */
  dsn: string | undefined;
  environment: string;
  getContext: () => ScrubContext;
}

/**
 * Starts error reporting. Call it after first paint (see main.tsx): the SDK is imported here on
 * demand, so it is not in the initial bundle and is not downloaded at all without a DSN.
 *
 * Errors only. No session replay, no performance tracing, no breadcrumbs, no user, and every
 * event is rebuilt from an allowlist by scrubEvent before it leaves the browser.
 */
export async function startErrorReporting(options: ErrorReportingOptions): Promise<boolean> {
  if (!options.dsn) {
    queue = [];
    return false;
  }
  const Sentry = await import('./sentry-client');
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    // Only what catches errors. The default set would also record console output, clicked
    // elements, fetch URLs and the page address as breadcrumbs and request data.
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
    // Belt and braces: collection is switched off at the source as well as scrubbed on the way
    // out. This SDK version collects several of these by default.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeBreadcrumb: () => null,
    // The SDK's event type is wider than SafeEvent, and scrubEvent returns nothing outside it.
    beforeSend: (event) => scrubEvent(event, options.getContext()) as typeof event | null,
  });
  capture = (error) => {
    Sentry.captureException(error);
  };
  for (const error of queue) capture(error);
  queue = [];
  return true;
}

/** For tests: forget the reporter and anything queued. */
export function resetErrorReporting(): void {
  capture = undefined;
  queue = [];
}
