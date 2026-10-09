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
