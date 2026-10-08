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
    },
  }),
);
