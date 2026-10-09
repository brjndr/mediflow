import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { resetMockDb } from '@/mocks/db';
import { server } from '@/mocks/node';
import { configureApi, resetApiConfig } from '@/shared/api';
import { missingTranslationKeys } from './render';

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
