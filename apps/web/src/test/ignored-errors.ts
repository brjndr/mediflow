// Errors that reach Vitest outside any test and do not fail the run (`onUnhandledError` in
// vitest.config.ts, which imports this file, so it imports nothing from the app).

/**
 * A test that ends while a request is in flight (the page aborts it on navigation) can make
 * undici's fetch assert `!this.aborted` when the response then arrives, after every test has
 * passed (seen once on web shard 2, #819). Only that one assertion is ignored; any other
 * unhandled error still fails the run.
 */
export function isIgnoredUnhandledError(error: { message?: string }): boolean {
  return /assert\(!this\.aborted\)/.test(error.message ?? '');
}
