import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The hospital's audit log (#1066) in a real browser, against the mock backend, at desktop,
 * tablet and phone width: the list, a search and an export asked for with the keyboard alone, with
 * focus visible at each step, and nothing scrolling sideways.
 */

const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

/** Reached by Tab, as the keyboard would arrive at it. */
async function reach(page: Page, target: ReturnType<Page['getByRole']>) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
}

test('search the audit log and export it with the keyboard alone', async ({ page }) => {
  await page.addStyleTag({ content: '*{transition:none!important}' }).catch(() => {});
  await page.goto('/');
  await goTo(page, 'Audit log');
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(page.getByText('rec_1', { exact: true }).first()).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Narrow the list to invoices.
  await page.getByRole('textbox', { name: /^Kind of record/ }).fill('invoice');
  await reach(page, page.getByRole('button', { name: 'Search' }));
  await page.keyboard.press('Enter');
  await expect(page.getByText('rec_2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('rec_1', { exact: true }).first()).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Export the days: followed until ready, then downloaded by a signed link asked for on press.
  await reach(page, page.getByRole('button', { name: 'Export these days (CSV)' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('The export is ready', { timeout: 15_000 });
  await expectNoAxeViolations(page);
  const link = page.waitForRequest((request) => request.url().includes('/download-url'));
  await reach(page, page.getByRole('button', { name: 'Download CSV' }));
  await page.keyboard.press('Enter');
  await link;
});
