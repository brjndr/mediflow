import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// Optional: point at an existing Chromium instead of downloading one (e.g. a shared machine).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const chromium = executablePath ? { launchOptions: { executablePath } } : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : 1,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  // The three widths the app supports (see Responsive Design in CLAUDE.md). Every spec runs at
  // each of them, all in Chromium: locally only Chromium is installed, and what is being checked
  // is the layout, not the browser. CI can add Firefox and WebKit later.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...chromium },
    },
    {
      // A tablet held upright: the narrowest width that still gets the desktop content layout.
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        ...chromium,
      },
    },
    {
      // The narrowest phone the app supports.
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 740 },
        ...chromium,
      },
    },
  ],
  webServer: {
    command:
      'cross-env VITE_API_MOCKING=enabled pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !isCI,
    timeout: 180_000,
  },
});
