import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Reports (#121) in a real browser, against the mock backend. Reports are a desktop-only screen
 * (CLAUDE.md, Responsive Design): at desktop width an export asked for, followed until it is ready
 * and downloaded, with the keyboard alone and focus visible at each step; below that, the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;
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

test('below desktop width a report is its notice, with nothing asked of the server', async ({
  page,
}) => {
  test.skip(isDesktop(page), 'Checked below desktop width.');
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/reports')) asked.push(request.url());
  });
  await page.goto('/');
  await goTo(page, 'Reports');
  await expect(
    page.getByRole('heading', { name: 'This screen needs a wider display' }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  expect(asked).toEqual([]);
});

test('show a report, then export one and download it with the keyboard alone', async ({ page }) => {
  test.skip(!isDesktop(page), 'Reports are a desktop-only screen.');
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.addStyleTag({ content: '*{transition:none!important}' }).catch(() => {});
  await page.goto('/');
  await goTo(page, 'Reports');
  await expect(page.getByRole('heading', { name: 'Reports', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Exports' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Show a report now.
  await reach(page, page.getByRole('button', { name: 'Show report' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'OPD census' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Report shown');
  await expectNoAxeViolations(page);

  // Export one, with the page still usable while it is made.
  await page.getByRole('combobox', { name: /^Report/ }).selectOption('revenue');
  await reach(page, page.getByRole('button', { name: 'Export' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Export requested');
  await expect(page.getByRole('button', { name: 'Show report' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('The export is ready', { timeout: 15_000 });
  await expectNoAxeViolations(page);

  // Download it from the list: the signed link is asked for when the button is pressed.
  const link = page.waitForRequest((request) => request.url().includes('/download-url'));
  await reach(page, page.getByRole('button', { name: /^Download CSV/ }).first());
  await page.keyboard.press('Enter');
  await link;
  await expect(page.getByRole('status')).toContainText('Download started');
  await expectNoSidewaysScroll(page);
});
