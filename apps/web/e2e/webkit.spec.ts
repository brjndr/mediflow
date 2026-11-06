import { expect, test } from '@playwright/test';
import { goTo } from './support';

/**
 * What WebKit (Safari on iOS) is known to do differently from Chromium, checked on the
 * `webkit-phone` project, which runs in CI only (#334). Skipped in every other project.
 */

test.skip(({ browserName }) => browserName !== 'webkit', 'WebKit only');

test('a date input takes a typed value and keeps it', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Appointments');
  const from = page.getByLabel('From', { exact: true });
  await from.fill('2031-03-04');
  await expect(from).toHaveValue('2031-03-04');
  await page.getByRole('link', { name: 'Book an appointment' }).click();
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
  const day = page.getByLabel('Day');
  await day.fill('2031-03-05');
  await expect(day).toHaveValue('2031-03-05');
});

test('a finger is the pointer, and the controls are touch-sized', async ({ page }) => {
  await page.goto('/?mockUser=none');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const box = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
});

test('inputs are 16 px or more, so focusing one does not zoom the page', async ({ page }) => {
  await page.goto('/?mockUser=none');
  await expect(page.getByLabel('Email')).toBeVisible();
  const sizes = await page
    .locator('input:visible')
    .evaluateAll((inputs) => inputs.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);

  // The viewport tag never forbids zoom, and focusing a field leaves the scale alone.
  const content = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(content).not.toMatch(/maximum-scale|user-scalable/);
  await page.getByLabel('Email').focus();
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
});

test('signing out in one tab signs out another, over BroadcastChannel', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  // One tab at a time: in WebKit, two pages starting the mock's service worker together may not boot.
  await first.goto('/');
  await expect(first.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await second.goto('/notices');
  await expect(second.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await first.getByRole('button', { name: 'Sign out' }).click();
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a tab in the background still signs out when idle time runs out', async ({ context }) => {
  await context.clock.install();
  const first = await context.newPage();
  await first.goto('/notices');
  await expect(first.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/notices');
  await expect(second.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await second.bringToFront();

  await context.clock.fastForward('31:00');
  await expect(first.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
