// Memory soak (#138): drives the production preview (`pnpm build` with VITE_API_MOCKING=enabled,
// then `pnpm preview --port 4173`) through the main routes for a set time and fails when the JS
// heap, measured after a forced garbage collection, keeps growing. Not part of CI (30 minutes);
// run it before a release:  pnpm --filter web soak [minutes=30] [baseUrl=http://localhost:4173]
import { chromium } from '@playwright/test';

const minutes = Number(process.argv[2] ?? 30);
const base = process.argv[3] ?? 'http://localhost:4173';
const routes = ['/', '/patients', '/appointments', '/encounters', '/reports', '/inventory'];
const maxGrowth = 0.2; // the last quarter's median heap may exceed the first quarter's by 20%

const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');

const samples = [];
const end = Date.now() + minutes * 60_000;
let step = 0;
while (Date.now() < end) {
  const path = routes[step % routes.length];
  if (step === 0) {
    await page.goto(base + path);
  } else {
    // A client-side navigation, as a user makes it, not a reload that would reset the heap.
    await page.evaluate(
      `history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'))`,
    );
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  if (step % 3 === 2) {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    samples.push(usedSize);
    console.log(`${new Date().toISOString()} heap ${(usedSize / 1048576).toFixed(1)} MB`);
  }
  step += 1;
}
await browser.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const quarter = Math.max(1, Math.floor(samples.length / 4));
const first = median(samples.slice(0, quarter));
const last = median(samples.slice(-quarter));
const growth = last / first - 1;
console.log(
  `first quarter ${(first / 1048576).toFixed(1)} MB, last quarter ${(last / 1048576).toFixed(1)} MB, growth ${(growth * 100).toFixed(1)}%`,
);
if (growth > maxGrowth) {
  console.error('The heap is not flat.');
  process.exit(1);
}
