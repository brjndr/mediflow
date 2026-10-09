// The only file that imports the SDK. It names exactly what is used, so the bundler can drop the
// rest (replay, tracing, feedback). Importing the whole namespace would ship all of it. This
// module is itself imported on demand by error-reporting.ts.
export {
  captureException,
  dedupeIntegration,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
} from '@sentry/browser';
