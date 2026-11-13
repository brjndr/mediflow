import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Discharging a patient end to end (DS-05, #168) in a real browser against the mock backend, at
 * every supported width: admit, clear the ward, write and sign the summary, look at the final bill
 * and discharge. A full page load resets the mock, so everything after the first load happens
 * inside the app.
 */

async function admitPatient(page: Page) {
  await page.goto('/');
  await goTo(page, 'Bed board');
  await page.getByRole('link', { name: 'Admissions' }).click();
  await page.getByRole('link', { name: 'Admit a patient' }).click();
  await page.getByRole('combobox', { name: /^Patient/ }).fill('MRN-PTH-00010');
  await page.getByRole('option', { name: /MRN-PTH-00010/ }).click();
  const doctor = page.getByRole('combobox', { name: /Admitting doctor/ });
  await expect(doctor.getByRole('option')).not.toHaveCount(1);
  await doctor.selectOption({ index: 1 });
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Admit patient' }).click();
  await expect(page.getByRole('heading', { name: 'Patient admitted' })).toBeVisible();
  await page.getByRole('link', { name: 'Admissions' }).click();
  await expect(page.getByRole('heading', { name: 'Admissions', level: 1 })).toBeVisible();
}

test('clear the ward, summarize, check the bill and discharge', async ({ page }) => {
  await admitPatient(page);
  const action = (name: RegExp) =>
    page.getByRole('link', { name }).or(page.getByRole('button', { name })).first();

  // Open clearances hold the discharge.
  await page
    .getByRole('button', { name: /Discharge/ })
    .first()
    .click();
  const panel = page.getByRole('region', { name: /Discharge / });
  await expect(panel.getByTestId('clearance-gate')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Discharge patient' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  for (const kind of ['Nursing', 'Pharmacy (medicines to return)', 'Laboratory (pending tests)']) {
    await panel.getByRole('button', { name: `Mark ${kind} cleared` }).click();
    await expect(panel.getByRole('button', { name: `Reopen ${kind}` })).toBeVisible();
  }
  await expect(panel.getByTestId('clearance-gate')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The summary is written and signed.
  await action(/Summary of stay/).click();
  await expect(page.getByRole('heading', { name: 'Discharge summary', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /^Diagnoses/ }).fill('Pneumonia');
  await page.getByRole('textbox', { name: /^Course in hospital/ }).fill('Recovered on antibiotics');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Sign summary' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign summary' }).click();
  await expect(page.getByRole('article', { name: 'Discharge summary' })).toContainText('Pneumonia');
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  // The final bill of the stay.
  await page.getByRole('link', { name: 'Admissions' }).first().click();
  await action(/Running bill/).click();
  await expect(page.getByRole('heading', { name: /bill/i, level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Then the patient leaves.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Admissions', level: 1 })).toBeVisible();
  await page
    .getByRole('button', { name: /^Discharge/ })
    .first()
    .click();
  const leaving = page.getByRole('region', { name: /Discharge / });
  const submit = leaving.getByRole('button', { name: 'Discharge patient' });
  // This new stay has no charges, so the bill has nothing unsettled and holds nothing back.
  await expect(submit).not.toHaveAttribute('aria-disabled');
  await submit.click();
  await expect(page.getByText(/is discharged./)).toBeVisible();
});
