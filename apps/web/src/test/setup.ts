import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { resetMockDb } from '@/mocks/db';
import { server } from '@/mocks/node';
import { configureApi, resetApiConfig } from '@/shared/api';
import { missingTranslationKeys } from './render';

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
