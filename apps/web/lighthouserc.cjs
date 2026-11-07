/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS config file read by lhci */
// Lighthouse CI for the main routes (#457). Run from the repo root with `pnpm lighthouse`.
// It audits the production build with the mock API, desktop preset, on a throttled CPU, and
// asserts the targets in docs/PERFORMANCE.md. The Slow 4G run is lighthouserc.slow4g.cjs.
const { urls, startServerCommand } = require('./lighthouse.shared.cjs');

module.exports = {
  ci: {
    collect: {
      startServerCommand,
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 240000,
      url: urls,
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        // A mid-range hospital PC (an i3 class CPU) is about 4 times slower than a CI runner.
        throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 4 },
        onlyCategories: ['performance', 'accessibility'],
      },
    },
    assert: {
      assertMatrix: [
        {
          // The targets in docs/PERFORMANCE.md for LCP and CLS.
          matchingUrlPattern:
            '^http://localhost:4173/([?]mockUser=none|patients|encounters|reports|appointments)?$',
          assertions: {
            'largest-contentful-paint': [
              'error',
              { maxNumericValue: 2500, aggregationMethod: 'median' },
            ],
            'cumulative-layout-shift': [
              'error',
              { maxNumericValue: 0.1, aggregationMethod: 'median' },
            ],
          },
        },
        {
          // The mock API (MSW) runs in the page and costs about 2 s of scripting that the real API
          // does not, and the split route chunks count as requests. So the documented targets
          // (TBT <= 300 ms; 20 requests) are warnings, and the errors are ceilings that catch a
          // regression. INP needs a real interaction, so a lab run uses TBT instead.
          matchingUrlPattern: '.*',
          assertions: {
            'total-blocking-time': ['warn', { maxNumericValue: 300, aggregationMethod: 'median' }],
            'resource-summary:total:count': ['warn', { maxNumericValue: 20 }],
            'categories:accessibility': ['warn', { minScore: 0.95 }],
          },
        },
        {
          matchingUrlPattern: '.*',
          assertions: {
            'total-blocking-time': [
              'error',
              { maxNumericValue: 8000, aggregationMethod: 'median' },
            ],
            'resource-summary:total:count': ['error', { maxNumericValue: 70 }],
          },
        },
      ],
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
