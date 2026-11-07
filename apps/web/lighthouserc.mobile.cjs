/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS config file read by lhci */
// The phone run (#138): Lighthouse's mobile form factor (a 360 px screen, touch and a phone's user
// agent) on the login page, the patient list and the encounter screen, with the same LCP and CLS
// targets as the desktop run. The network is a good 4G connection and the CPU is slowed 4 times
// (a mid-range phone); the Slow 4G run is lighthouserc.slow4g.cjs.
const { urls, startServerCommand } = require('./lighthouse.shared.cjs');

const phoneUrls = [urls[0], urls[2], urls[4]];

module.exports = {
  ci: {
    collect: {
      startServerCommand,
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 240000,
      url: phoneUrls,
      numberOfRuns: 3,
      settings: {
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 360,
          height: 740,
          deviceScaleFactor: 2,
          disabled: false,
        },
        throttling: { rttMs: 70, throughputKbps: 9000, cpuSlowdownMultiplier: 4 },
        onlyCategories: ['performance', 'accessibility'],
      },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: '.*',
          assertions: {
            'largest-contentful-paint': [
              'error',
              { maxNumericValue: 2500, aggregationMethod: 'median' },
            ],
            'cumulative-layout-shift': [
              'error',
              { maxNumericValue: 0.1, aggregationMethod: 'median' },
            ],
            // As in the desktop run: the mock API's scripting makes TBT a warning at the target
            // and an error only at a ceiling that catches a regression.
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
    // Inside the desktop run's folder, which CI already uploads as `lighthouse-reports`.
    upload: { target: 'filesystem', outputDir: '.lighthouseci/mobile' },
  },
};
