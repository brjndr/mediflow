import { expect } from 'vitest';

/**
 * `expect(button).toBeUnavailable()`: the control says it cannot be used (`aria-disabled`) but is
 * not `disabled`, so it keeps focus (see `Button`). Busy buttons and row actions are this; a
 * control that is truly `disabled` is not.
 */
expect.extend({
  toBeUnavailable(received: Element) {
    const said = received.getAttribute('aria-disabled') === 'true';
    // :disabled counts a control inside a disabled fieldset too.
    const disabled = received.matches(':disabled');
    // Negated, it asks that the control can be pressed: neither unavailable nor disabled.
    if (this.isNot) {
      return {
        pass: said || disabled,
        message: () =>
          disabled
            ? 'expected the control to be available, but it is disabled'
            : 'expected the control to be available, but it says aria-disabled',
      };
    }
    return {
      pass: said && !disabled,
      message: () =>
        disabled
          ? 'expected aria-disabled, not disabled: a disabled control loses focus'
          : 'expected the control to say it is unavailable (aria-disabled="true")',
    };
  },
});

declare module 'vitest' {
  // Vitest 5's signature: R is what a matcher returns (a promise after .resolves), T the value.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toBeUnavailable: () => R;
  }
}
