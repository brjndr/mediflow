import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The invoice builder (#109) in a real browser against the mock backend, at every supported
 * width: from the consultation to a bill with one charge left off, issued, with the keyboard
 * alone and focus visible at each step.
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

test('bill a visit from the consultation and issue it with the keyboard alone', async ({
  page,
}) => {
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();

  const create = page.getByRole('link', { name: 'Create invoice' });
  await expect(create).toBeVisible();
  await reach(page, create);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'New invoice', level: 1 })).toBeVisible();
  const charges = page.getByRole('table', { name: 'Pending charges' });
  const cards = page.getByRole('list', { name: 'Pending charges' });
  await expect(charges.or(cards).first()).toBeVisible();
  const total = page.getByTestId('invoice-total');
  await expect(total).toContainText('901.00');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Leaving one charge off keeps the keyboard where it was.
  const leave = page.getByRole('button', { name: 'Leave off the bill: Complete blood count' });
  await reach(page, leave);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(total).toContainText('551.00');
  await expect(leave).toBeFocused();

  // A line typed in, with the keyboard: description, quantity and price, then Add line.
  await page.getByRole('textbox', { name: /^What it is for/ }).fill('Copy of the records');
  await page.getByRole('textbox', { name: /^Price of one/ }).fill('10.50');
  const add = page.getByRole('button', { name: 'Add line' });
  await reach(page, add);
  await page.keyboard.press('Enter');
  await expect(total).toContainText('561.50');
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  const issue = page.getByRole('button', { name: 'Issue invoice' });
  await reach(page, issue);
  expect(await focusVisible(page)).toBe(true);
  await expectNoSidewaysScroll(page);
  await page.keyboard.press('Enter');

  await expect(
    page.getByText(/^Invoice INV-0001 was issued on .+ and can no longer be changed\.$/),
  ).toBeVisible();
  await expect(page.getByTestId('invoice-total')).toContainText('561.50');
  await expect(page.getByRole('button', { name: 'Issue invoice' })).toHaveCount(0);
  // Focus is never left on the page body.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('find an issued invoice in the list and print it with the keyboard alone', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  // The mock keeps no invoice until one is made: issue the visit's pending charges inside the app.
  await page.evaluate(async () => {
    const made = await fetch('/api/encounters/enc_h_1/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ chargeIds: ['chg_h_1', 'chg_h_2'], manualLines: [] }),
    });
    const draft = (await made.json()) as { id: string; version: number };
    await fetch(`/api/invoices/${draft.id}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ version: draft.version }),
    });
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });

  await goTo(page, 'Billing');
  await expect(page.getByRole('heading', { name: 'Invoices', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  const search = page.getByRole('searchbox', { name: 'Find an invoice' });
  await search.fill('INV-0001');
  const open = page.getByRole('link', { name: 'INV-0001' });
  await expect(open).toBeVisible();
  await expectNoAxeViolations(page);
  await reach(page, open);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');

  await expect(page.getByText(/^Invoice INV-0001 was issued on /)).toBeVisible();
  const print = page.getByRole('button', { name: 'Print invoice' });
  await reach(page, print);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
    .toBe(1);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});
