import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The appointment list in a real browser against the mock backend, at every supported width:
 * today's appointments at the hospital, a page at a time, narrowed by doctor and by status, over
 * several days, and from a row to the patient's own screen.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

test('list today’s appointments, narrow them, and open a patient', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Appointments');
  await expect(page.getByRole('heading', { name: 'Appointments', exact: true })).toBeVisible();
  // Six doctors with a morning of appointments each.
  await expect(status(page, '48 appointments')).toBeVisible();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
  await expectNoSidewaysScroll(page);

  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Cancelled' });
  await expect(status(page, /\d+ appointments?/)).toBeVisible();
  // The badge of a row, not the option of the filter.
  await expect(page.locator('span', { hasText: /^Cancelled$/ }).first()).toBeVisible();

  // Tomorrow as well: twice as many, before any status filter.
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'All statuses' });
  const from = await page.getByLabel('From', { exact: true }).inputValue();
  const tomorrow = new Date(`${from}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await page.getByLabel('To', { exact: true }).fill(tomorrow.toISOString().slice(0, 10));
  await expect(status(page, '96 appointments')).toBeVisible();

  // A row opens its patient, by id.
  await page
    .getByRole('button', { name: /^Open the patient/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/patients\/pth_\d{5}$/);
  await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();
});
