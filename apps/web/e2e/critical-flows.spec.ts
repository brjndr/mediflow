import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The critical flows of the pilot (H-04, #141) in a real browser against the mock backend, at
 * every supported width. The module specs check each screen on its own; this one checks that
 * they hand over to each other: one new patient from the front desk to a paid invoice, then who
 * may do what, and that a second hospital sees none of it.
 *
 * A full page load resets the mock, so the journey stays inside the app after the first load.
 */

const heading = (page: Page, name: string, level = 1) =>
  page.getByRole('heading', { name, level, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

/** Goes to an address the way a link inside the app does, without reloading the page. */
async function navigateInApp(page: Page, path: string) {
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

test('a new patient from registration to a paid invoice', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const patient = 'Meera Zachariah';

  // Front desk: register.
  await goTo(page, 'Patients');
  await page.getByRole('link', { name: 'Register a patient' }).click();
  await page.getByLabel('First name').fill('Meera');
  await page.getByLabel('Last name').fill('Zachariah');
  await page.getByLabel('Date of birth').fill('1988-03-14');
  await page.getByLabel('Gender').selectOption({ label: 'Female' });
  await page.getByLabel('Phone number').fill('+91 98111 22334');
  await page.getByLabel('The patient agrees to be contacted').check();
  await page.getByRole('button', { name: 'Register patient' }).click();
  await expect(heading(page, 'Patient registered')).toBeVisible();
  await expect(page.getByText('MRN-PTH-12001')).toBeVisible();

  // Front desk: a token in the queue.
  await goTo(page, 'OPD queue');
  await page.getByRole('link', { name: 'Issue a token' }).click();
  await page.getByRole('combobox', { name: 'Patient' }).fill('MRN-PTH-12001');
  await page.getByRole('option', { name: /MRN-PTH-12001/ }).click();
  await page.getByRole('combobox', { name: /^Department/ }).selectOption('dep_h_02');
  await page.getByRole('button', { name: 'Issue token' }).click();
  const issued = page.getByRole('heading', { name: /^Token \d+ issued$/ });
  await expect(issued).toBeVisible();
  await page.getByRole('link', { name: 'Back to the queue' }).click();
  await expect(heading(page, 'OPD queue')).toBeVisible();

  // Nurse: vitals for that token.
  await page.locator('a[href^="/triage/pth_12001"]').click();
  await expect(heading(page, 'Record vitals')).toBeVisible();
  await page.getByRole('textbox', { name: /^Systolic/ }).fill('120');
  await page.getByRole('textbox', { name: /^Diastolic/ }).fill('80');
  await page.getByRole('button', { name: 'Save vitals' }).click();
  await expect(heading(page, 'Vitals saved')).toBeVisible();
  // The allergies are asked, so the prescription is checked against them.
  await page.getByRole('button', { name: 'Record allergies' }).click();
  await page.getByRole('combobox', { name: /^Allergies/ }).selectOption('none');
  await page.getByRole('button', { name: 'Save allergies' }).click();
  await expect(page.getByText('Allergies saved.')).toBeVisible();

  // Doctor: calls the patients in turn until this one is next, then starts the consultation.
  await goTo(page, 'OPD queue');
  await expect(heading(page, 'OPD queue')).toBeVisible();
  await page.getByRole('combobox', { name: 'Doctor' }).selectOption('doc_h_02');
  const serving = page.getByRole('region', { name: 'Now serving' });
  const callNext = page.getByRole('button', { name: /^Call next for / });
  for (let call = 0; call < 8; call += 1) {
    await callNext.click();
    await expect(status(page, /^Token \d+, .+, called\.$/)).toBeVisible();
    if (await serving.getByText(patient).isVisible()) break;
  }
  await serving
    .locator('tr, li')
    .filter({ hasText: patient })
    .getByRole('button', { name: /^Start consultation/ })
    .click();
  await expect(heading(page, 'Consultation')).toBeVisible();
  await expect(page.getByText(patient).first()).toBeVisible();

  // Doctor: orders a lab test and writes a prescription.
  const orders = page
    .getByRole('heading', { name: 'Lab orders' })
    .locator('xpath=ancestor::section[1]');
  await orders.getByRole('combobox', { name: 'Test or panel' }).fill('haemoglobin');
  await page.getByRole('option', { name: 'Haemoglobin (HB), Single test' }).click();
  await orders.getByRole('button', { name: 'Order the test' }).click();
  await expect(page.getByText('Test ordered.')).toBeVisible();

  await page.getByRole('button', { name: 'Write a prescription' }).click();
  await page.getByRole('combobox', { name: 'Medicine' }).fill('paracetamol');
  await page
    .getByRole('option', { name: /^Paracetamol 500 mg/ })
    .first()
    .click();
  await page.getByRole('textbox', { name: /^Dose/ }).fill('1 tablet');
  await page.getByRole('textbox', { name: /^Frequency/ }).fill('1-1-1');
  await page.getByRole('textbox', { name: /^Days/ }).fill('2');
  await page.getByRole('textbox', { name: /^Quantity/ }).fill('6');
  await page.getByRole('button', { name: 'Write the prescription' }).click();
  await expect(page.getByText('Prescription written.')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Laboratory: collect, receive, result, verify.
  await goTo(page, 'Laboratory');
  await page.getByRole('button', { name: `Collect sample: ${patient}, Haemoglobin` }).click();
  const panel = page.getByRole('region', { name: 'Collect sample: Haemoglobin' });
  await panel.getByRole('button', { name: 'Mark as collected' }).click();
  await expect(panel.getByRole('status')).toHaveText(/^Collected as \d{6}-\d{4}\./);
  await panel.getByRole('button', { name: 'Close' }).click();
  const stage = page.getByRole('combobox', { name: 'Stage' });
  await stage.selectOption('collected');
  await page.getByRole('button', { name: `Receive: ${patient}, Haemoglobin` }).click();
  await expect(page.getByText(/^Sample \d{6}-\d{4} received\./)).toBeVisible();
  await stage.selectOption('received');
  await page.getByRole('button', { name: `Results: ${patient}, Haemoglobin` }).click();
  await page.getByRole('textbox', { name: 'Haemoglobin (g/dL)' }).fill('13.5');
  await page.getByRole('button', { name: 'Save results' }).click();
  await page.getByRole('button', { name: 'Verify ticked results' }).click();
  await expect(page.getByText(/the order is completed/)).toBeVisible();

  // The doctor sees the verified result in the consultation.
  await goTo(page, 'Consultations');
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(patient) })
    .first()
    .click();
  const released = page
    .getByRole('heading', { name: 'Lab results of this visit' })
    .locator('xpath=ancestor::section[1]');
  await expect(released.getByText('13.5 g/dL')).toBeVisible();

  // Pharmacy: the prescription is dispensed from the batches.
  await goTo(page, 'Pharmacy');
  await page
    .getByRole('button', { name: new RegExp(`^Dispense: Prescription of ${patient}`) })
    .click();
  await page.getByRole('button', { name: /^Dispense: Paracetamol/ }).click();
  const dispense = page.getByRole('region', { name: /^Dispense Paracetamol/ });
  await dispense.getByRole('button', { name: 'Dispense', exact: true }).click();
  await expect(status(page, /units? of Paracetamol/)).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Billing: the visit's charges become an invoice, which is paid in full.
  await goTo(page, 'Consultations');
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(patient) })
    .first()
    .click();
  await page.getByRole('link', { name: 'Create invoice' }).click();
  await expect(heading(page, 'New invoice')).toBeVisible();
  // The billing desk charges a service to the visit, and it joins the bill.
  await page.getByRole('combobox', { name: 'Service' }).fill('Wound dressing');
  await page.getByRole('option', { name: /Wound dressing/ }).click();
  await page.getByRole('button', { name: 'Add charge' }).click();
  await expect(page.getByTestId('invoice-total')).not.toContainText(/\b0\.00$/);
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByText(/^Invoice INV-\d+ was issued on /)).toBeVisible();
  const due = page.getByTestId('balance-due');
  await expect(due).not.toContainText(/\b0\.00$/);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(due).toContainText('0.00');
  await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

/** What each sample role may reach, by the addresses of the links its navigation holds. */
const ROLES = [
  {
    user: 'user_receptionist',
    has: ['/patients', '/queue'],
    lacks: ['/billing/invoices', '/lab', '/pharmacy', '/inventory'],
  },
  {
    user: 'user_pharmacist',
    has: ['/pharmacy'],
    lacks: ['/billing/invoices', '/lab', '/queue'],
  },
  {
    user: 'user_store_keeper',
    has: ['/inventory'],
    lacks: ['/billing/invoices', '/lab', '/pharmacy/sales'],
  },
  {
    user: 'user_billing_clerk',
    has: ['/billing/invoices'],
    lacks: ['/queue', '/lab', '/pharmacy', '/inventory'],
  },
];

for (const role of ROLES) {
  test(`${role.user} reaches its own work and none of the others`, async ({ page }) => {
    const apiPaths: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/')) apiPaths.push(pathname);
    });
    await page.goto(`/?mockUser=${role.user}`);
    await expect(heading(page, 'Hospital management system')).toBeVisible();
    // By address, so a link in the closed drawer of a narrow screen counts too.
    for (const path of role.has) {
      await expect(page.locator(`a[href="${path}"]`).first()).toBeAttached();
    }
    for (const path of role.lacks) {
      await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
    }
    // By hand, the first address it lacks answers "no access" and asks the server for nothing.
    const forbidden = role.lacks[0] ?? '/';
    await navigateInApp(page, forbidden);
    await expect(
      page.getByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(apiPaths.filter((path) => /invoices|charges/.test(path))).toEqual([]);
    await expectNoAxeViolations(page);
  });
}

test('a second hospital sees none of the first one’s work', async ({ page }) => {
  await page.goto('/?mockUser=user_doctor');
  await page.getByRole('button', { name: 'Sample Hospital' }).click();
  await expect(heading(page, 'Hospital management system')).toBeVisible();
  await goTo(page, 'Consultations');
  await expect(heading(page, 'Consultations')).toBeVisible();
  await page.getByRole('main').getByRole('link').first().click();
  await expect(heading(page, 'Consultation')).toBeVisible();
  const consultation = new URL(page.url()).pathname;

  await page
    .getByRole('combobox', { name: 'Hospital' })
    .selectOption({ label: 'Riverside Clinic' });
  await expect(heading(page, 'Hospital management system')).toBeVisible();
  // The first hospital's consultation, by its address, is not there for the clinic.
  await navigateInApp(page, consultation);
  await expect(page.getByText('This consultation is not available.')).toBeVisible();
  await expect(page.getByText('Asha Verma1')).toHaveCount(0);
});
