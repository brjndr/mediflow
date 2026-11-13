import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Ward care (NR-06, #162) in a real browser against the mock backend, at every supported width:
 * a nurse charts vital signs, a diet order is placed, a medication dose is charted and a doctor
 * writes a round note. Row actions are found by name, so the same locators serve the table and
 * the cards on a phone. A full page load resets the mock, so everything after the first load
 * happens inside the app.
 */

/** Admits a patient of the mock and puts a medication order on the stay. */
async function admitWithMedication(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const send = async (path: string, body: unknown) => {
      const answer = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return (await answer.json()) as { id?: string; encounterId?: string };
    };
    const doctors = (await (await fetch('/api/doctors?limit=1')).json()) as {
      items: { id: string }[];
    };
    const stay = await send('/admissions', {
      patientId: 'pth_00001',
      admissionType: 'planned',
      doctorId: doctors.items[0]?.id,
    });
    await send(`/encounters/${stay.encounterId ?? ''}/orders`, {
      type: 'medication',
      itemName: 'Paracetamol 500 mg',
      dose: '500 mg',
      route: 'oral',
      frequency: 'SOS',
    });
  });
}

/** Opens a row action of the one admitted patient on the ward worklist. */
async function fromWorklist(page: Page, action: RegExp): Promise<void> {
  await goTo(page, 'Ward care');
  await expect(page.getByRole('heading', { name: 'Ward care', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: action }).first().click();
}

const status = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

test('chart vitals, place a diet order, chart a dose and write a round note', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await admitWithMedication(page);

  // Vital signs: a low pressure, a fast pulse and a low SpO2 score as urgent.
  await fromWorklist(page, /Chart vitals/);
  await expect(page.getByRole('heading', { name: /^Vital signs: /, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Enter at least one measurement.')).toBeVisible();
  await page.getByRole('textbox', { name: /Systolic/ }).fill('85');
  await page.getByRole('textbox', { name: /Diastolic/ }).fill('50');
  await page.getByRole('textbox', { name: /Pulse/ }).fill('118');
  await page.getByRole('textbox', { name: /SpO2/ }).fill('90');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(status(page, 'Vital signs recorded.')).toBeVisible();
  await expect(page.getByText('85/50 (low)')).toBeVisible();
  await expect(page.getByText('Ask a doctor to review the patient now.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // An order from the ward: a diet order becomes the stay's current diet.
  await page.getByRole('link', { name: 'Back to ward care' }).click();
  await page.getByRole('button', { name: /^Diet/ }).first().click();
  await expect(page.getByRole('heading', { name: /^Diet: /, level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Diet and instructions/ }).fill('Soft diet, no salt');
  await page.getByRole('button', { name: 'Place diet order' }).click();
  await expect(status(page, 'The diet order was placed.')).toBeVisible();
  await expect(page.getByText('Current diet')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Administer: chart the dose of the medication order as given.
  await page.getByRole('link', { name: 'Back to the kitchen list' }).click();
  await fromWorklist(page, /Medication chart/);
  await expect(page.getByRole('heading', { name: /^Medication chart: /, level: 1 })).toBeVisible();
  await page
    .getByRole('button', { name: /Chart dose/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Chart a dose' });
  await expect(dialog.getByRole('textbox', { name: /Dose given/ })).toHaveValue('500 mg');
  await dialog.getByRole('button', { name: 'Chart dose' }).click();
  await expect(status(page, 'Dose charted.')).toBeVisible();
  await expect(page.getByText('500 mg oral', { exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // A round note: written, then listed with the stay's notes.
  await page.getByRole('link', { name: 'Back to ward care' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Doctor rounds' }).click();
  await expect(page.getByRole('heading', { name: 'Doctor rounds', level: 1 })).toBeVisible();
  const doctor = page.getByRole('combobox', { name: 'Doctor' });
  if (await doctor.isVisible()) await doctor.selectOption({ label: 'All doctors' });
  await page
    .getByRole('button', { name: /Progress notes/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /^Progress notes: /, level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Note/ }).fill('Pressure low on rounds, fluids started.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(status(page, 'Note added.')).toBeVisible();
  await expect(page.getByText('Pressure low on rounds, fluids started.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('the vitals form is filled and submitted with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await admitWithMedication(page);
  await fromWorklist(page, /Chart vitals/);
  await expect(page.getByRole('heading', { name: /^Vital signs: /, level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Systolic/ }).focus();
  await page.keyboard.type('120');
  await page.keyboard.press('Tab');
  await page.keyboard.type('80');
  await page.keyboard.press('Enter');
  await expect(status(page, 'Vital signs recorded.')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
  await expectNoAxeViolations(page);
});
