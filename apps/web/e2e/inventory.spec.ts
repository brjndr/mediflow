import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Inventory (#102) in a real browser against the mock backend, at every supported width: the
 * stock with its alerts, approving an adjustment the store keeper asked for, and asking for one,
 * with the keyboard alone and focus visible at each step. The mock starts signed in as the
 * hospital's admin, who did not ask for the waiting adjustments and so may approve them.
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

test('approve an adjustment and ask for another with the keyboard alone', async ({ page }) => {
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Inventory');
  await expect(page.getByRole('heading', { name: 'Stock', level: 1 })).toBeVisible();
  await expect(page.getByText(/SB001A, expires/).first()).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The expiring alert narrows the list.
  const expiring = page.getByRole('button', { name: /items? expiring$/ });
  await reach(page, expiring);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(expiring).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('1 item.')).toBeVisible();

  const adjustments = page.getByRole('link', { name: 'Adjustments' });
  await reach(page, adjustments);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Stock adjustments', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const approve = page.getByRole('button', { name: /^Approve: .+, 10 units, Main store$/ });
  await reach(page, approve);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  // The row leaves the waiting list, so focus goes to the status line that says what was done.
  await expect(page.getByRole('status').filter({ hasText: 'Approved: 10 units' })).toBeFocused();

  const add = page.getByRole('button', { name: 'New adjustment' });
  await reach(page, add);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'New stock adjustment' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);

  // The item: typed, chosen from the list with the arrows and Enter.
  const item = panel.getByRole('combobox', { name: 'Item' });
  await reach(page, item);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('gloves');
  await expect(panel.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Change' })).toBeFocused();

  const place = panel.getByRole('combobox', { name: /^Place/ });
  await reach(page, place);
  await place.selectOption({ label: 'Main store' });
  const reason = panel.getByRole('combobox', { name: /^Reason/ });
  await reach(page, reason);
  await reason.selectOption({ label: 'Opening stock' });
  // The batch number is a text box: the one combobox named so is the batch.
  const batch = panel.getByRole('combobox', { name: /^Batch/ });
  await reach(page, batch);
  await batch.selectOption({ label: 'A new batch' });
  const number = panel.getByLabel(/^Batch number/);
  await reach(page, number);
  await page.keyboard.type('GL-90');
  await reach(page, panel.getByLabel(/^Expiry date/));
  await panel.getByLabel(/^Expiry date/).fill('2028-06-30');
  const units = panel.getByLabel(/^Units/);
  await reach(page, units);
  await page.keyboard.type('50');
  expect(await focusVisible(page)).toBe(true);
  await expectNoAxeViolations(page);

  const submit = panel.getByRole('button', { name: 'Ask for approval' });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'It waits for approval.' }),
  ).toBeFocused();
  await expect(page.getByText(/New batch GL-90/)).toBeVisible();
  await expectNoAxeViolations(page);
});
