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

  // Payments (#111): a part payment by card, then the rest, with the keyboard alone.
  await expect(page.getByRole('heading', { name: 'Payments', level: 2 })).toBeVisible();
  await expect(page.getByTestId('balance-due')).toContainText('561.50');
  const amount = page.getByRole('textbox', { name: /^Amount/ });
  await amount.fill('100');
  await page.getByLabel(/^Paid by/).selectOption('card');
  const record = page.getByRole('button', { name: 'Record payment' });
  await reach(page, record);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: /Payment of .*100.00.* recorded./ }),
  ).toBeVisible();
  await expect(page.getByTestId('balance-due')).toContainText('461.50');
  await expect(amount).toHaveValue('461.50');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // A credit note (#112) with a reason, with the keyboard alone: 11.50 off what is unpaid.
  await expect(page.getByRole('heading', { name: 'Credit notes', level: 2 })).toBeVisible();
  const credit = page.getByRole('textbox', { name: /^Credit amount/ });
  await credit.fill('11.50');
  await page.getByRole('textbox', { name: /^Reason/ }).fill('Consultation fee waived');
  const issueCredit = page.getByRole('button', { name: 'Issue credit note' });
  await reach(page, issueCredit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Credit note CN-0001 issued.' }),
  ).toBeVisible();
  await expect(page.getByTestId('balance-due')).toContainText('450.00');
  await expect(amount).toHaveValue('450.00');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await reach(page, record);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('balance-due')).toContainText('0.00');
  await expect(record).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // A refund (#444) of 50.00 from the last cash payment, with a reason, with the keyboard alone.
  await expect(page.getByRole('heading', { name: 'Refund a payment' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Refund amount/ }).fill('50');
  await page.getByRole('textbox', { name: /^Refund reason/ }).fill('Charged twice');
  const refund = page.getByRole('button', { name: 'Refund payment' });
  await reach(page, refund);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: /Refund of .*50.00.* recorded./ }),
  ).toBeVisible();
  await expect(page.getByTestId('balance-due')).toContainText('50.00');
  await expect(amount).toHaveValue('50.00');
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

test('a receptionist without billing permissions has no way into billing', async ({ page }) => {
  // The clinic's receptionist holds none of the billing permissions (src/mocks/db.ts).
  const paths: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) paths.push(pathname);
  });
  await page.goto('/?mockUser=user_receptionist');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  // By address, so a link in the closed drawer of a phone counts too.
  await expect(page.locator('a[href="/billing/invoices"]')).toHaveCount(0);
  await page.evaluate(() => {
    window.history.pushState({}, '', '/billing/invoices');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(
    page.getByRole('heading', { name: 'You do not have access to this page' }),
  ).toBeVisible();
  expect(paths.filter((path) => /invoices|charges/.test(path))).toEqual([]);
  await expectNoAxeViolations(page);
});

test('open the cash register and settle it with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Billing');
  const link = page.getByRole('link', { name: 'Cash register', exact: true });
  await expect(link).toBeVisible();
  await reach(page, link);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'Cash register', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open the register' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Opening: the cash in the drawer, then the button, both reached by Tab.
  const opening = page.getByRole('textbox', { name: /^Cash in the drawer/ });
  await reach(page, opening);
  expect(await focusVisible(page)).toBe(true);
  await opening.fill('100');
  const open = page.getByRole('button', { name: 'Open register' });
  await reach(page, open);
  await page.keyboard.press('Enter');
  // The form goes; focus moves on to the status line that says what happened.
  await expect(page.getByRole('heading', { name: /^Open since/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Register opened' })).toBeFocused();
  await expect(page.getByTestId('expected')).toContainText('100.00');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Settling: the count, a note for the handover, and the button.
  const counted = page.getByRole('textbox', { name: /^Cash counted/ });
  await reach(page, counted);
  expect(await focusVisible(page)).toBe(true);
  await counted.fill('95');
  await page.getByRole('textbox', { name: /^Note for the handover/ }).fill('Five short');
  const close = page.getByRole('button', { name: 'Close and settle' });
  await reach(page, close);
  await page.keyboard.press('Enter');
  const status = page.getByRole('status').filter({ hasText: 'Register settled' });
  await expect(status).toContainText('Short by');
  await expect(status).toBeFocused();
  await expect(page.getByRole('button', { name: 'Print settlement' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The day-end list shows the settled session, and its page opens from the keyboard.
  await reach(page, page.getByRole('link', { name: 'All sessions and day-end' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Cash register sessions' })).toBeVisible();
  const session = page.getByRole('main').getByRole('link', { name: 'Sample Admin' }).first();
  await expect(session).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await reach(page, session);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Register session', level: 1 })).toBeVisible();
  await expect(page.getByTestId('difference')).toContainText('Short by');
  await expectNoSidewaysScroll(page);
});
