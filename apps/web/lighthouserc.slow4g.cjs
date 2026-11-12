/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS config file read by lhci */
// The Slow 4G run for the login page and the app shell (#457). Only these two have to stay usable
// on a throttled connection (docs/PERFORMANCE.md), so the limits are looser than on broadband.
const { urls, startServerCommand } = require('./lighthouse.shared.cjs');

module.exports = {
  ci: {
    collect: {
      startServerCommand,
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 240000,
      url: [urls[0], urls[1]],
      numberOfRuns: 3,
      settings: {
        formFactor: 'desktop',
        screenEmulation: { disabled: true },
        // Lighthouse's own Slow 4G figures.
        throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
        onlyCategories: ['performance'],
      },
    },
    assert: {
      assertions: {
        // About 5 s on a slow machine: the target is 4 s, this limit catches a regression meanwhile.
        'largest-contentful-paint': [
          'error',
          { maxNumericValue: 7000, aggregationMethod: 'median' },
        ],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1, aggregationMethod: 'median' }],
        'total-blocking-time': ['error', { maxNumericValue: 8000, aggregationMethod: 'median' }],
        'resource-summary:total:count': ['error', { maxNumericValue: 70 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci-slow4g' },
  },
};
