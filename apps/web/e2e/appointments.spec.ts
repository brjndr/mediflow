import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

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
  // Tomorrow at the hospital (Asia/Kolkata), whose appointments have not started.
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 86_400_000),
  );
  await page.goto('/');
  await goTo(page, 'Appointments');
  await page.getByLabel('To', { exact: true }).fill(tomorrow);
  await page.getByLabel('From', { exact: true }).fill(tomorrow);
  await page.getByRole('combobox', { name: 'Status' }).selectOption('scheduled');
  await expect(status(page, /\d+ appointments?/)).toBeVisible();
  await page
    .getByRole('button', { name: /^Open the appointment/ })
    .first()
    .click();
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

/** The next weekday at the hospital (Asia/Kolkata) after today, when the doctors work. */
function nextWorkingDay(): string {
  for (let ahead = 1; ; ahead++) {
    const at = new Date(Date.now() + ahead * 86_400_000);
    const weekday = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
    }).format(at);
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(at);
    }
  }
}

/** Moves focus with Tab until it is in the calendar's grid, which is one Tab stop. */
async function tabIntoGrid(page: Page) {
  await page.getByRole('button', { name: 'Today' }).focus();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.closest('[role="grid"]') !== null)) {
      return;
    }
  }
  throw new Error('The calendar grid was not reached with Tab');
}

const focusedName = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');

/** One doctor's chosen day, in the day view, with the keyboard. */
async function openDayOf(page: Page, day: string) {
  await page.getByRole('combobox', { name: 'Doctor' }).selectOption('doc_h_01');
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.getByRole('button', { name: 'Day', exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  await page.getByLabel('Go to date').fill(day);
  await expect(status(page, '8 appointments')).toBeVisible();
}

test('book and move an appointment from the calendar with the keyboard alone', async ({ page }) => {
  const day = nextWorkingDay();
  await page.goto('/appointments/calendar');
  await openDayOf(page, day);

  // One Tab stop for the grid; the arrows go past the morning's eight appointments to eleven.
  await tabIntoGrid(page);
  expect(await focusedName(page)).toMatch(/^9:00\s?am to 9:15\s?am, /i);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedName(page)).toMatch(/^11:00\s?am, .*nothing booked\. Book at this time\.$/i);
  await page.keyboard.press('Enter');

  // Booking opens with the doctor, the day and the time chosen.
  await expect(page).toHaveURL(/\/appointments\/new\?/);
  await expect(page.getByRole('button', { name: /^11:00\s?am$/i, pressed: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Patient' }).focus();
  await page.keyboard.type('MRN-PTH-00001');
  await expect(page.getByRole('option', { name: /MRN-PTH-00001/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Change patient' })).toBeVisible();
  await page.getByRole('button', { name: 'Book', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Appointment booked' })).toBeVisible();

  // Back to the calendar (inside the app, so the mock keeps the booking), to the new one.
  await page.goBack();
  await openDayOf(page, day);
  await expect(status(page, '9 appointments')).toBeVisible();
  await tabIntoGrid(page);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedName(page)).toMatch(/^11:00\s?am to 11:15\s?am, .+ with .+, Scheduled$/i);
  await page.keyboard.press('Enter');

  // Moved to noon, with the keyboard.
  await expect(page).toHaveURL(/\/appointments\/apt_\w+$/);
  await page.getByRole('button', { name: 'Move' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /^12:00\s?pm$/i }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /^12:00\s?pm$/i, pressed: true })).toBeVisible();
  await page.getByRole('combobox', { name: /^Reason/ }).selectOption('patient_request');
  await page.getByRole('button', { name: 'Move to this time' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('The appointment was moved.')).toBeVisible();
});

const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element
      ? `${element.tagName.toLowerCase()}:${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''}`
      : '';
  });

test('book from the list with the keyboard alone, led to what was missed', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Appointments');
  await page.getByRole('link', { name: 'Book an appointment' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();

  // Sent empty: focus goes to the first field to fix, the patient, with its message.
  await page.getByRole('button', { name: 'Book', exact: true }).focus();
  await page.keyboard.press('Enter');
  const patient = page.getByRole('combobox', { name: 'Patient' });
  await expect(patient).toBeFocused();
  await expect(patient).toHaveAccessibleDescription('Choose the patient.');
  await page.keyboard.type('MRN-PTH-00001');
  await expect(page.getByRole('option', { name: /MRN-PTH-00001/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Change patient' })).toBeFocused();

  await page.getByRole('combobox', { name: 'Doctor' }).selectOption('doc_h_10');
  await page.getByLabel('Day').fill(nextWorkingDay());
  const times = page.getByRole('group', { name: 'Time (required)' });
  await expect(times.getByRole('status')).toHaveText('16 free times.');

  // Sent without a time: focus goes to the first free one, chosen with Space.
  await page.getByRole('button', { name: 'Book', exact: true }).focus();
  await page.keyboard.press('Enter');
  const first = times.getByRole('button').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('Space');
  await expect(first).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Book', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Appointment booked' })).toBeFocused();
  expect(await focused(page)).toBe('h1:Appointment booked');
  await expectNoAxeViolations(page);
});

test('cancel an appointment with the keyboard alone, and come back to where it started', async ({
  page,
}) => {
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 86_400_000),
  );
  await page.goto('/');
  await goTo(page, 'Appointments');
  await page.getByLabel('To', { exact: true }).fill(tomorrow);
  await page.getByLabel('From', { exact: true }).fill(tomorrow);
  await expect(status(page, /\d+ appointments?/)).toBeVisible();
  await page
    .getByRole('button', { name: /^Open the appointment/ })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Appointment', exact: true })).toBeVisible();

  // A panel takes focus when it opens, and gives it back to its button when left.
  const opener = page.getByRole('button', { name: 'Cancel the appointment' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Cancel the appointment', level: 2 }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Keep it' }).focus();
  await page.keyboard.press('Enter');
  await expect(opener).toBeFocused();

  // Sent without a reason: focus goes to it.
  await page.keyboard.press('Enter');
  const submit = page.getByRole('button', { name: 'Cancel the appointment' });
  await submit.focus();
  await page.keyboard.press('Enter');
  const reason = page.getByRole('combobox', { name: 'Reason' });
  await expect(reason).toBeFocused();
  await reason.selectOption('patient_request');
  await submit.focus();
  await page.keyboard.press('Enter');

  // Said from the status region, and focus on the heading: nothing is left to do to it.
  await expect(
    page.getByRole('status').filter({ hasText: 'The appointment was cancelled.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appointment', exact: true })).toBeFocused();
  await expectNoAxeViolations(page);
});
