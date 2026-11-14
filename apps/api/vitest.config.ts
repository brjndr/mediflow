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
    // `buildTestApp` registers every feature and takes about 15 s on a cold 2-core machine; on a loaded CI
    // runner or beside another suite it passed the 10 s default (#842). A hook that hangs for real still fails.
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
