import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { resetMockDb } from '@/mocks/db';
import { server } from '@/mocks/node';
import { configureApi, resetApiConfig } from '@/shared/api';

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
});
afterAll(() => server.close());
