import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Applies migrations to the test database once, before any test file.
    globalSetup: ['./test/global-setup.ts'],
    env: { NODE_ENV: 'test' },
    // Test files share one database, so they run one after another.
    fileParallelism: false,
    maxWorkers: 2,
    restoreMocks: true,
  },
});
