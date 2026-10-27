import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Purchasing (#103) in a real browser against the mock backend, at every supported width:
 * receiving goods against the approved order and sending some back, with the keyboard alone and
 * focus visible at each step. The mock starts signed in as the hospital's admin; PO-000003 is
 * approved with nothing received.
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

test('receive goods and send some back with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Purchasing');
  await expect(page.getByRole('heading', { name: 'Purchase orders', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const open = page.getByRole('button', { name: /^Open: PO-000003/ });
  await reach(page, open);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Purchase order PO-000003', level: 1 }),
  ).toBeVisible();

  const receive = page.getByRole('button', { name: 'Receive goods' });
  await reach(page, receive);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Receive goods against PO-000003' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);

  const number = panel.getByLabel(/^Batch number of/).first();
  await reach(page, number);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('KB-1');
  const expiry = panel.getByLabel(/^Expiry date of/).first();
  await reach(page, expiry);
  await expiry.fill('2030-06-30');
  // The second item did not come: its units are emptied.
  const secondUnits = panel.getByLabel(/^Units of/).nth(1);
  await reach(page, secondUnits);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expectNoAxeViolations(page);

  const submit = panel.getByRole('button', { name: 'Receive goods' });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'GRN-000001 received.' })).toBeFocused();
  await expect(page.getByText('Partly received').first()).toBeVisible();

  const receipt = page.getByRole('button', { name: /^Open: GRN-000001/ });
  await reach(page, receipt);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Goods receipt GRN-000001', level: 1 }),
  ).toBeVisible();
  const send = page.getByRole('button', { name: 'Return to supplier' });
  await reach(page, send);
  await page.keyboard.press('Enter');
  const back = page.getByRole('region', { name: /^Return to / });
  await expect(back.getByRole('heading', { level: 2 })).toBeFocused();
  const units = back.getByLabel(/^Units of .*KB-1/);
  await reach(page, units);
  await page.keyboard.type('5');
  await expectNoAxeViolations(page);
  const confirm = back.getByRole('button', { name: 'Return to supplier' });
  await reach(page, confirm);
  await page.keyboard.press('Enter');
  await expect(back).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'PRN-000001 recorded.' })).toBeFocused();
});
