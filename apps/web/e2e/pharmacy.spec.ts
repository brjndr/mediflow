import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The pharmacy (#100) in a real browser against the mock backend, at every supported width:
 * opening the prescription from the queue and dispensing a line from the batches nearest expiry,
 * with the keyboard alone and focus visible at each step. The mock starts signed in as the
 * hospital's admin.
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

test('dispense a line with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Pharmacy');
  await expect(page.getByRole('heading', { name: 'Pharmacy', level: 1 })).toBeVisible();
  await expect(page.getByText('2 of 2 to dispense')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const open = page.getByRole('button', { name: /^Dispense: / }).first();
  await reach(page, open);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Dispense prescription', level: 1 }),
  ).toBeVisible();
  await expectNoAxeViolations(page);

  const dispense = page.getByRole('button', { name: /^Dispense: Paracetamol/ });
  await reach(page, dispense);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: /^Dispense Paracetamol/ });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  // Nearest expiry first: the 4 of PCM24A, then 2 of PCM25B.
  await expect(panel.getByRole('textbox', { name: /^Batch PCM24A/ })).toHaveValue('4');
  await expect(panel.getByRole('textbox', { name: /^Batch PCM25B/ })).toHaveValue('2');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const submit = panel.getByRole('button', { name: 'Dispense', exact: true });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  // The panel closes, so focus goes to the status line that says what was done.
  await expect(
    page.getByRole('status').filter({ hasText: '6 units of Paracetamol' }),
  ).toBeFocused();
  await expect(page.getByRole('button', { name: /^Print slip of Paracetamol/ })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('sell an item at the counter with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Pharmacy');
  const sales = page.getByRole('link', { name: 'Counter sales' });
  await reach(page, sales);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Counter sales', level: 1 })).toBeVisible();
  const create = page.getByRole('link', { name: 'New sale' });
  await reach(page, create);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'New counter sale', level: 1 })).toBeVisible();
  await expectNoAxeViolations(page);

  // An item is found with its search and chosen with the arrows and Enter.
  const search = page.getByRole('combobox', { name: 'Add an item' });
  await reach(page, search);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('CetiCare');
  const wanted = page.getByRole('option', { name: 'Cetirizine 10 mg Tablet (CetiCare)' });
  await expect(wanted).toBeVisible();
  for (
    let step = 0;
    step < 30 && (await wanted.getAttribute('aria-selected')) !== 'true';
    step += 1
  ) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(wanted).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const units = page.getByRole('textbox', { name: /^Units of Cetirizine/ });
  await expect(units).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('2');
  await expectNoSidewaysScroll(page);

  const submit = page.getByRole('button', { name: 'Record sale' });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Counter sale', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Sale recorded.' })).toBeVisible();
  await expectNoAxeViolations(page);
});
