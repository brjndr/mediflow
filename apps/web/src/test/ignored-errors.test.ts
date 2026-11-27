import { isIgnoredUnhandledError } from './ignored-errors';

// What Node says when an `assert` given no message of its own fails.
const failed = (expression: string) =>
  `The expression evaluated to a falsy value:\n\n  ${expression}\n`;

describe('isIgnoredUnhandledError', () => {
  it("ignores undici's assertion on a response to an aborted request", () => {
    expect(isIgnoredUnhandledError({ message: failed('assert(!this.aborted)') })).toBe(true);
  });

  it('lets every other error fail the run', () => {
    expect(isIgnoredUnhandledError({ message: failed('assert(!this.completed)') })).toBe(false);
    expect(isIgnoredUnhandledError({ message: failed('assert(this.aborted)') })).toBe(false);
    expect(isIgnoredUnhandledError({ message: 'assert!this.aborted' })).toBe(false);
    expect(isIgnoredUnhandledError({})).toBe(false);
  });
});
