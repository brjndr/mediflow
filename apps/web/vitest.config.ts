import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default defineConfig(() =>
  mergeConfig(viteConfig, {
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      // The dev laptop has 2 cores: keep at most 2 workers (CLAUDE.md Package Manager).
      maxWorkers: 2,
      restoreMocks: true,
      // A screen test renders the whole app and takes several seconds on a slow or busy machine,
      // so the default of 5 s fails tests that are only slow (#1216). It is well above how long
      // one wait may take (asyncUtilTimeout in src/test/setup.ts), so a wait that fails says
      // what it was looking for rather than "test timed out".
      testTimeout: 60_000,
      // A test that ends while a request is in flight (the page aborts it on navigation) can make
      // undici's fetch assert `!this.aborted` when the response then arrives, after every test has
      // passed (seen once on web shard 2, #819). Only that one assertion is ignored; any other
      // unhandled error still fails the run.
      onUnhandledError(error: { message?: string }) {
        if (/assert(!this.aborted)/.test(error.message ?? '')) return false;
      },
      // `pnpm test:coverage` (what CI runs). Coverage is measured and enforced for the foundation
      // only: the code that keeps hospitals apart and decides who may do what. A change that
      // leaves part of it untested fails here. Feature folders are not held to a threshold.
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: [
          'src/access/**',
          'src/tenancy/**',
          'src/registry/**',
          'src/shared/api/**',
          'src/app/session/**',
        ],
        exclude: ['**/*.test.{ts,tsx}'],
        // Set a little below what the suite reaches today (100 / 95 / 96 / 98), so an honest
        // refactor has room but a dropped test does not.
        thresholds: { lines: 98, branches: 92, functions: 93, statements: 97 },
      },
    },
  }),
);
