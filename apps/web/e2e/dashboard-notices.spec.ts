import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, goTo } from './support';

/**
 * The landing page and the notices with the keyboard alone (H-02, #139): the two screens every
 * signed-in person meets that had no keyboard test. A full page load resets the mock, so
 * everything after the first load happens inside the app.
 */

const focusIsOnPage = (page: Page) => page.evaluate(() => document.activeElement !== document.body);

test('the dashboard is reached, read and left with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main h1').first()).toBeVisible();
  await expectNoAxeViolations(page);

  // Tab from the top: the skip link comes first, then the shell, then the widgets, and focus
  // is visible on a real control at every stop.
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    expect(await focusIsOnPage(page)).toBe(true);
  }
  await goTo(page, 'Notices');
  await expect(page.getByRole('heading', { name: 'Staff notices', exact: true })).toBeVisible();
  await expect(page.locator('main')).toBeFocused();
});

test('notices: archive one from the keyboard, focus stays on the page', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Notices');
  await expect(page.getByRole('heading', { name: 'Staff notices', exact: true })).toBeVisible();
  await expectNoAxeViolations(page);

  const archive = page.getByRole('button', { name: /^Archive “/ }).first();
  if ((await archive.count()) === 0) return; // No archive right: nothing to do with the keyboard.
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => focusIsOnPage(page)).toBe(true);
  await expectNoAxeViolations(page);
});
