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

test('return units of a dispense with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Pharmacy');
  await page
    .getByRole('button', { name: /^Dispense: / })
    .first()
    .click();
  const dispense = page.getByRole('button', { name: /^Dispense: Cetirizine/ });
  await dispense.click();
  const given = page.getByRole('region', { name: /^Dispense Cetirizine/ });
  await expect(given.getByRole('textbox', { name: /^Batch CTZ25A/ })).toHaveValue('5');
  await given.getByRole('button', { name: 'Dispense', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '5 units of Cetirizine' })).toBeVisible();

  // #104: some back to stock, some wasted, with a reason.
  const open = page.getByRole('button', { name: /^Return items of Cetirizine/ });
  await reach(page, open);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: /^Return items of Cetirizine/ });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Tab');
  await expect(panel.getByRole('textbox', { name: 'Units of CTZ25A back to stock' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('2');
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('textbox', { name: /^Units of CTZ25A wasted/ })).toBeFocused();
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('textbox', { name: /^Why they are returned/ })).toBeFocused();
  await page.keyboard.type('Rash after the first dose');
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Record return' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  // The panel closes, so focus goes to the status line that says what was done.
  await expect(page.getByRole('status').filter({ hasText: '3 units of Cetirizine' })).toBeFocused();
  await expect(page.getByText(/1 unit of CTZ25A wasted/)).toBeVisible();
  await expectNoAxeViolations(page);
});

test('a medicine from the doctor’s prescription, through purchase and receipt, to the dispense (#106)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  // The doctor prescribes a medicine.
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  await page.getByRole('button', { name: 'Write a prescription' }).click();
  await page.getByRole('combobox', { name: 'Medicine' }).fill('aceclofenac');
  await page.getByRole('option', { name: /^Aceclofenac 5 mg Tablet \(AcecCare\)/ }).click();
  await page.getByRole('textbox', { name: /^Dose/ }).fill('1 tablet');
  await page.getByRole('textbox', { name: /^Frequency/ }).fill('1-0-1');
  await page.getByRole('textbox', { name: /^Days/ }).fill('3');
  await page.getByRole('button', { name: 'Write the prescription' }).click();
  await expect(page.getByText('Prescription written.')).toBeVisible();

  // It waits in the pharmacy queue, and only the counter's one batch is there to give it from.
  await goTo(page, 'Pharmacy');
  await expect(page.getByText('1 of 1 to dispense')).toBeVisible();
  // The queue is oldest first: the new prescription is the last row.
  await page
    .getByRole('button', { name: /^Dispense: / })
    .last()
    .click();
  await page.getByRole('button', { name: /^Dispense: Aceclofenac/ }).click();
  const panel = page.getByRole('region', { name: /^Dispense Aceclofenac/ });
  await expect(panel.getByRole('textbox', { name: /^Batch SB001B/ })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: /^Batch AC-1/ })).toHaveCount(0);

  // The store buys it: the approved order is received into stock.
  await goTo(page, 'Purchasing');
  await page.getByRole('button', { name: /^Open: PO-000003/ }).click();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  const receive = page.getByRole('region', { name: 'Receive goods against PO-000003' });
  await receive
    .getByLabel(/^Batch number of/)
    .first()
    .fill('AC-1');
  await receive
    .getByLabel(/^Expiry date of/)
    .first()
    .fill('2030-06-30');
  await receive
    .getByLabel(/^Units of/)
    .nth(1)
    .fill('');
  await receive.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'GRN-000001 received.' })).toBeVisible();

  // The stock list shows the batch.
  await goTo(page, 'Inventory');
  await expect(page.getByRole('heading', { name: 'Stock', level: 1 })).toBeVisible();
  await expect(page.getByText(/AC-1, expires/).first()).toBeVisible();

  // The pharmacy now dispenses the prescription from that batch.
  await goTo(page, 'Pharmacy');
  await page
    .getByRole('button', { name: /^Dispense: / })
    .last()
    .click();
  // The goods came into the main store, so that is where this dispense reads its stock from.
  await page
    .getByRole('combobox', { name: /^Dispense from/ })
    .selectOption({ label: 'Main store' });
  await page.getByRole('button', { name: /^Dispense: Aceclofenac/ }).click();
  const dispense = page.getByRole('region', { name: /^Dispense Aceclofenac/ });
  // The new batch is offered, and the units come from it.
  await dispense.getByRole('textbox', { name: /^Batch AC-1/ }).fill('3');
  await dispense.getByRole('button', { name: 'Dispense', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '3 units of Aceclofenac' }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});
