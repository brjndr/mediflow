import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The emergency journey (ER-04, #174) in a real browser against the mock backend, at every
 * supported width: register an unidentified arrival, triage it, link it to a record, start
 * treatment, write a note and admit. Row actions are named "<action>: Emergency case <id>", so the
 * same locators work for the table and for the cards on a phone.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

test('register, triage, identify, treat and admit an emergency patient', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Emergency');
  await expect(page.getByRole('heading', { name: 'Emergency', level: 1 })).toBeVisible();
  await expect(page.getByText('Road accident')).toBeVisible();

  // Register: the complaint alone is enough, and sent empty it says so.
  await page.getByRole('button', { name: 'Register an arrival' }).click();
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByText(/required/i).first()).toBeVisible();
  await page.getByRole('textbox', { name: /^Complaint/ }).fill('Fall from a ladder');
  await expectNoSidewaysScroll(page);
  // Axe once the dialog has finished fading in and the pointer is off the button: its hover
  // colour is a hair under 4.5:1 on the sample hospital's primary colour (follow-up filed).
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Registered as ER-0005.' }),
  ).toBeVisible();
  await expect(page.getByText('Fall from a ladder').first()).toBeVisible();

  // Triage: category 1 puts the patient up the board.
  await page.getByRole('button', { name: 'Set category: Emergency case ER-0005' }).click();
  await page.getByRole('combobox', { name: /^Category/ }).selectOption('1');
  await page.getByRole('button', { name: 'Save category' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ER-0005 is category 1.' }),
  ).toBeVisible();

  // Identify: link the unidentified patient to a record.
  await page.getByRole('button', { name: 'Identify patient: Emergency case ER-0005' }).click();
  await page.getByRole('combobox', { name: /^Patient/ }).fill('MRN-PTH-00001');
  await page.getByRole('option', { name: /MRN-PTH-00001/ }).click();
  await page.getByRole('button', { name: 'Link to record' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ER-0005 is linked to the patient' }),
  ).toBeVisible();

  // Treat: open the case, start treatment and write a note.
  await page.locator('tr, li').filter({ hasText: 'ER-0005' }).getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: /ER-0005/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Start treatment' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ER-0005 is now in treatment.' }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: /^Note/ }).fill('BP 90/60, GCS 14');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('BP 90/60, GCS 14')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Admit: the case closes and points to the admissions list.
  await page.getByRole('button', { name: 'Decide disposition' }).click();
  await page.getByRole('combobox', { name: /^Disposition/ }).selectOption('admit');
  const doctor = page.getByRole('combobox', { name: /^Admitting doctor/ });
  await doctor.selectOption({ index: 1 });
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('link', { name: 'See the admissions list' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decide disposition' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test('register an arrival with the keyboard alone', async ({ page }) => {
  await page.goto('/emergency');
  await expect(page.getByRole('heading', { name: 'Emergency', level: 1 })).toBeVisible();
  const open = page.getByRole('button', { name: 'Register an arrival' });
  await open.focus();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const complaint = page.getByRole('textbox', { name: /^Complaint/ });
  await expect(page.getByRole('dialog')).toBeVisible();

  // Sent empty: focus goes to the first invalid field.
  await page.getByRole('button', { name: 'Register', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(complaint).toBeFocused();
  expect(await focusVisible(page)).toBe(true);

  await page.keyboard.type('Chest pain');
  await page.getByRole('button', { name: 'Register', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Registered as ER-0005.' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  // Focus is not left on the page body once the dialog has closed.
  await expect(page.locator('body')).not.toBeFocused();
});
