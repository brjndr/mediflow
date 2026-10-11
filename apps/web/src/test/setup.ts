import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { resetMockDb } from '@/mocks/db';
import { server } from '@/mocks/node';
import { configureApi, resetApiConfig } from '@/shared/api';
import { missingTranslationKeys } from './render';

// How long findBy* and waitFor keep trying. The default of one second is too tight for the first
// test of a file on a slow machine, where a lazy route chunk is still being transformed. A test
// that passes is no slower; only a failing one takes longer to say so.
configure({ asyncUtilTimeout: 3000 });

// jsdom has no modal <dialog>. This covers what the app relies on (the open attribute and the
// close event). Focus trapping and Escape are the browser's job and are not simulated.
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// Keep retry backoff out of test time. Tests that assert on timing set their own values.
const fastRetries = () => configureApi({ baseDelayMs: 1 });

beforeAll(() => {
  fastRetries();
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  resetMockDb();
  cleanup();
  resetApiConfig();
  fastRetries();
  // Every key a test rendered must have a translation (see missingTranslationKeys).
  const missing = missingTranslationKeys.splice(0);
  expect(missing, 'translation keys with no text in any language').toEqual([]);
});
afterAll(() => server.close());
