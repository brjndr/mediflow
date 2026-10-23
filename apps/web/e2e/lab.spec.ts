import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The laboratory worklist (#90) in a real browser against the mock backend, at every supported
 * width: a sample collected, its label printed and the sample received, with the keyboard alone
 * and focus visible at each step.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

/** Reached by Tab, as the keyboard would arrive at it. */
async function reach(page: Page, target: ReturnType<Page['getByRole']>) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

test('collect a sample, print its label and receive it with the keyboard alone', async ({
  page,
}) => {
  // The browser's own print dialog cannot be driven, so it is counted and closed at once.
  await page.addInitScript(() => {
    const counted = window as Window & { printed?: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed = (counted.printed ?? 0) + 1;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  const printed = () => page.evaluate(() => (window as Window & { printed?: number }).printed);
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  const collect = page.getByRole('button', { name: /^Collect sample: .+, Complete blood count$/ });
  await reach(page, collect);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Collect sample: Complete blood count' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(panel.getByText('Date of birth')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Mark as collected' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText(/^Collected as \d{6}-\d{4}\./);
  const accession = ((await panel.getByRole('status').textContent()) ?? '').match(
    /\d{6}-\d{4}/,
  )?.[0];

  // The button pressed becomes Print label, and keeps focus.
  const print = panel.getByRole('button', { name: 'Print label' });
  await expect(print).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(printed).toBe(1);
  await expect(page.locator('[data-print-sheet]')).toHaveCount(0);
  await expect(print).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);

  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('collected');
  const receive = page.getByRole('button', { name: /^Receive: .+, Complete blood count$/ });
  await reach(page, receive);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Sample ${accession} received.`, { exact: false })).toBeFocused();
  await expectNoAxeViolations(page);
});
