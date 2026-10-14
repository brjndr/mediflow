import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The appointment list in a real browser against the mock backend, at every supported width:
 * today's appointments at the hospital, a page at a time, narrowed by doctor and by status, over
 * several days, and from a row to the patient's own screen; and one doctor's calendar, by day
 * everywhere and by week where there is room.
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

test('one doctor’s calendar, by day and by week where there is room', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Appointments');
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Appointments calendar' });
  await expect(calendar).toBeVisible();
  // One of the six doctors with a morning of appointments each day.
  await page.getByRole('combobox', { name: 'Doctor' }).selectOption('doc_h_01');
  const blocks = calendar.locator('.rbc-event');
  await expect(blocks.first()).toBeVisible();
  await expectNoSidewaysScroll(page);

  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  // The week is for desktop width only (CLAUDE.md, Responsive Design).
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveCount(wide ? 1 : 0);
  if (wide) {
    await page.getByRole('button', { name: 'Day', exact: true }).click();
  }
  await expect(status(page, '8 appointments')).toBeVisible();
  await expect(blocks).toHaveCount(8);

  // Where the pointer is a finger, a fifteen-minute appointment is still a finger's target.
  if (await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)) {
    const box = await blocks.first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43);
  }

  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(status(page, '8 appointments')).toBeVisible();

  // An appointment opens its own screen, by id.
  await blocks.first().click();
  await expect(page).toHaveURL(/\/appointments\/apt_\w+$/);
  await expect(page.getByRole('heading', { name: 'Appointment', exact: true })).toBeVisible();
});

test('cancel an appointment with a reason', async ({ page }) => {
  // The mock seeds, for each day from three days ago, 48 appointments at the hospital in order:
  // the 193rd is the first of tomorrow, scheduled.
  await page.goto('/appointments/apt_tenant_1_00193');
  await expect(page.getByRole('heading', { name: 'Appointment', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as completed' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel the appointment' }).click();
  await page.getByRole('combobox', { name: /^Reason/ }).selectOption('patient_request');
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Cancel the appointment' }).click();
  await expect(page.getByText('The appointment was cancelled.')).toBeVisible();
  await expect(page.getByText('The patient asked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move' })).toHaveCount(0);
});
