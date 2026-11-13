import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Admitting a patient, moving them to another bed and seeing them on the bed board (IP-05, #155)
 * in a real browser against the mock backend, at every supported width. Row actions are found by
 * name, so the same locators serve the table and the cards on a phone. A full page load resets
 * the mock, so everything after the first load happens inside the app.
 */

test('admit a patient, move them to another bed and see them on the bed board', async ({
  page,
}) => {
  await page.goto('/');
  await goTo(page, 'Bed board');
  await page.getByRole('link', { name: 'Admissions' }).click();
  await expect(page.getByRole('heading', { name: 'Admissions', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Admit a patient' }).click();
  await expect(page.getByRole('heading', { name: 'Admit a patient', level: 1 })).toBeVisible();

  // Sent without a patient, a doctor or a bed, the form says so and admits nobody.
  await page.getByRole('button', { name: 'Admit patient' }).click();
  await expect(page.getByText(/required|Choose a free bed/i).first()).toBeVisible();

  await page.getByRole('combobox', { name: /^Patient/ }).fill('MRN-PTH-00010');
  await page.getByRole('option', { name: /MRN-PTH-00010/ }).click();
  const doctor = page.getByRole('combobox', { name: /Admitting doctor/ });
  await expect(doctor.getByRole('option')).not.toHaveCount(1);
  await doctor.selectOption({ index: 1 });
  await page.getByRole('radio').first().check();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Admit patient' }).click();
  await expect(page.getByRole('heading', { name: 'Patient admitted' })).toBeVisible();

  // The admission is in the list; give it another bed.
  await page.getByRole('link', { name: 'Admissions' }).click();
  await expect(page.getByRole('heading', { name: 'Admissions', level: 1 })).toBeVisible();
  await page
    .getByRole('button', { name: /Give or change bed/ })
    .first()
    .click();
  const panel = page.getByRole('region', { name: /to another bed/ });
  await expect(panel).toBeVisible();
  await panel.getByRole('radio').first().check();
  await expectNoAxeViolations(page);
  await panel.getByRole('button', { name: 'Move patient' }).click();
  await expect(page.getByText(/is now in bed/)).toBeVisible();

  // Both beds show in the stay's history.
  await page
    .getByRole('button', { name: /Bed history/ })
    .first()
    .click();
  const history = page.getByRole('region', { name: /Bed history of/ });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expectNoSidewaysScroll(page);

  // The board shows the bed in use.
  await goTo(page, 'Bed board');
  await expect(page.getByRole('heading', { name: 'Bed board', exact: true })).toBeVisible();
  await expect(page.locator('main :not(option):text-is("Occupied")').first()).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('the admit form is reachable with the keyboard alone', async ({ page }) => {
  await page.goto('/admissions/new');
  await expect(page.getByRole('heading', { name: 'Admit a patient', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: /^Patient/ }).focus();
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
  await page.keyboard.type('MRN-PTH-00010');
  await page.getByRole('option', { name: /MRN-PTH-00010/ }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Change patient' })).toBeVisible();
});
