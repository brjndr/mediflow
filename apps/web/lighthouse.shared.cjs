// What both Lighthouse CI configs audit. The first URL is the login page (signed out) and the
// second is the landing page of the app shell. The others start signed in as the sample hospital
// admin, which the mock does by default. A route is added here when a screen is added to the
// main flow.
const base = 'http://localhost:4173';

module.exports = {
  urls: [
    `${base}/?mockUser=none`,
    `${base}/`,
    `${base}/patients`,
    `${base}/appointments`,
    `${base}/encounters`,
    `${base}/reports`,
  ],
  // The same build the Playwright tests use: the mock API on, served as a static site.
  startServerCommand:
    'pnpm exec cross-env VITE_API_MOCKING=enabled pnpm build && pnpm preview --port 4173 --strictPort',
};
