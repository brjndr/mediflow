import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Indents (#105) in a real browser against the mock backend, at every supported width: approving
 * the pharmacist's indent for less than asked, then issuing it on a voucher, with the keyboard
 * alone and focus visible at each step. The mock starts signed in as the hospital's admin;
 * IND-000001 is the pharmacist's, waiting for approval.
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

test('approve an indent and issue it with the keyboard alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Indents');
  await expect(page.getByRole('heading', { name: 'Indents', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const open = page.getByRole('button', { name: /^Open: IND-000001/ });
  await reach(page, open);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Indent IND-000001', level: 1 })).toBeVisible();

  const approve = page.getByRole('button', { name: 'Approve' });
  await reach(page, approve);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Approve indent IND-000001' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);
  // The second item is not given: 0 units.
  const second = panel.getByLabel(/^Units of .* to approve/).nth(1);
  await reach(page, second);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('0');
  await expectNoAxeViolations(page);
  const submit = panel.getByRole('button', { name: 'Approve' });
  await reach(page, submit);
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Indent IND-000001 approved.' }),
  ).toBeFocused();

  const issue = page.getByRole('button', { name: 'Issue', exact: true });
  await reach(page, issue);
  await page.keyboard.press('Enter');
  const issuing = page.getByRole('region', { name: 'Issue against indent IND-000001' });
  await expect(issuing.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  const send = issuing.getByRole('button', { name: 'Issue', exact: true });
  await reach(page, send);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(issuing).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Voucher IV-000001 issued against indent' }),
  ).toBeFocused();
  // The store holds less of the first item than approved: the rest waits for another voucher.
  await expect(page.getByRole('definition').filter({ hasText: /^Partly issued$/ })).toBeVisible();
});
