import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Referrals and follow-ups (#88) in a real browser against the mock backend, at every supported
 * width: a referral and a follow-up made from the consultation, then the follow-up booked from
 * the due list, with the keyboard alone and focus visible at each step.
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

/** A weekday at the hospital (Asia/Kolkata) a week or more ahead, past the seeded bookings. */
function freeWorkingDay(): string {
  for (let ahead = 8; ; ahead++) {
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

test('refer, set a follow-up and book it from the due list with the keyboard alone', async ({
  page,
}) => {
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  const referrals = page
    .getByRole('heading', { name: 'Referrals' })
    .locator('xpath=ancestor::section[1]');
  await expect(referrals.getByText('No referrals.')).toBeVisible();

  // The department is chosen by typing its name on the closed list, as the keyboard does.
  const department = referrals.getByRole('combobox', { name: /^Department/ });
  await expect(department.getByRole('option', { name: 'Orthopaedics' })).toBeAttached();
  await reach(page, department);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('Orthopaedics');
  await expect(department).toHaveValue(/^dep_h_/);
  await page.keyboard.press('Tab');
  await expect(referrals.getByRole('combobox', { name: 'Doctor' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(referrals.getByRole('combobox', { name: /^Urgency/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(referrals.getByRole('textbox', { name: /^Referral reason/ })).toBeFocused();
  await page.keyboard.type('Knee pain on stairs');
  await page.keyboard.press('Tab');
  await expect(referrals.getByRole('button', { name: 'Refer' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(referrals.getByText('Referral made.')).toBeVisible();
  await expect(referrals.getByText('Knee pain on stairs')).toBeVisible();

  // The follow-up: a quick choice of days, then set.
  const followUp = page
    .getByRole('heading', { name: 'Follow-up', exact: true })
    .locator('xpath=ancestor::section[1]');
  const inWeek = followUp.getByRole('button', { name: 'In 7 days' });
  await reach(page, inWeek);
  await page.keyboard.press('Enter');
  const set = followUp.getByRole('button', { name: 'Set follow-up' });
  await reach(page, set);
  expect(await focusVisible(page)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(followUp.getByText('Follow-up set.')).toBeVisible();
  await expect(followUp.getByText('To book')).toBeVisible();

  // The desk's due list: booking opens in place, focus on its heading.
  await goTo(page, 'Follow-ups');
  await expect(page.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
  const book = page.getByRole('button', { name: /^Book: / }).first();
  await expect(book).toBeVisible();
  await reach(page, book);
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: /^Book the follow-up of / });
  await expect(heading).toBeFocused();
  const booking = heading.locator('xpath=..');
  await page.keyboard.press('Tab');
  await expect(booking.getByRole('combobox', { name: /^Doctor/ })).toBeFocused();
  await page.keyboard.press('Tab');
  const day = booking.getByLabel(/^Day/);
  await expect(day).toBeFocused();
  await day.fill(freeWorkingDay());
  const firstTime = booking.getByRole('group', { name: /^Time/ }).getByRole('button').first();
  await expect(firstTime).toBeVisible();
  await reach(page, firstTime);
  await page.keyboard.press('Enter');
  await expect(firstTime).toHaveAttribute('aria-pressed', 'true');
  const submit = booking.getByRole('button', { name: 'Book', exact: true });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Booked for .+ with /)).toBeVisible();
  // Focus is never left on the page body.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});
