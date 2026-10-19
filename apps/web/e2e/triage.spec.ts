import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Triage in a real browser against the mock backend, at every supported width: vitals recorded
 * for a token of the queue with the keyboard alone, a value out of range marked as it is typed,
 * and the allergies edited in place on the patient's screen, with focus never left on the page.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const focusedText = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName.toLowerCase()}:${element.textContent?.trim() ?? ''}` : '';
  });

test('record vitals for a token with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'OPD queue');
  await expect(page.getByRole('heading', { name: 'OPD queue', exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: /^Record vitals for token/ }).first();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Record vitals', exact: true })).toBeVisible();

  // Sent empty: focus goes to the first field, with what is missing.
  await page.getByRole('button', { name: 'Save vitals' }).focus();
  await page.keyboard.press('Enter');
  const systolic = page.getByRole('textbox', { name: /^Systolic/ });
  await expect(systolic).toBeFocused();
  await expect(systolic).toHaveAccessibleDescription(
    'Enter at least one measurement or the chief complaint.',
  );

  await page.keyboard.type('160');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('group', { name: 'Blood pressure' }).getByText('High')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Diastolic/ })).toBeFocused();
  await page.keyboard.type('90');
  await page.keyboard.press('Tab');
  await page.keyboard.type('84');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Enter');
  const saved = page.getByRole('heading', { name: 'Vitals saved' });
  await expect(saved).toBeFocused();
  await expect(
    page.getByText('Vitals saved. 2 values are outside the normal range.'),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await focusedText(page)).toBe('a:Back to the queue');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'OPD queue', exact: true })).toBeVisible();
});

test('edit a patient’s allergies in place with the keyboard alone', async ({ page }) => {
  await page.goto('/patients/pth_00001?tab=vitals');
  await expect(
    page.getByRole('tab', { name: 'Vitals and allergies', selected: true }),
  ).toBeVisible();
  const edit = page.getByRole('button', { name: 'Edit allergies' });
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Allergies' })).toBeFocused();

  await page.getByRole('button', { name: 'Add an allergy' }).focus();
  await page.keyboard.press('Enter');
  const second = page.getByRole('group', { name: 'Allergy 2' });
  await second.getByRole('textbox', { name: /^Substance/ }).focus();
  await page.keyboard.type('Peanuts');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Save allergies' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Allergies saved.')).toBeVisible();
  await expect(page.getByText('Peanuts')).toBeVisible();
  await expect(edit).toBeFocused();
});
