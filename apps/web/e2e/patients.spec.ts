import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The patient journey in a real browser, against the mock backend, at every supported width:
 * register someone, find them, open the record, change it. And the hospital boundary: one
 * hospital's patients are never shown in another.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const count = (page: Page) => page.getByRole('status').filter({ hasText: /patients?( loaded)?$/ });

/** Goes to an address the way a link inside the app does, without reloading the page. */
async function navigateInApp(page: Page, path: string) {
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

async function search(page: Page, text: string) {
  await page.getByLabel('Search patients').fill(text);
}

test('register a patient, find them, open the record and change it', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Patients');
  await expect(heading(page, 'Patients')).toBeVisible();
  await expect(count(page)).toHaveText('12000 patients');

  // Register.
  await page.getByRole('link', { name: 'Register a patient' }).click();
  await expect(heading(page, 'Register a patient')).toBeVisible();
  await page.getByLabel('First name').fill('Meera');
  await page.getByLabel('Last name').fill('Zachariah');
  await page.getByLabel('Date of birth').fill('1988-03-14');
  await page.getByLabel('Gender').selectOption({ label: 'Female' });
  await page.getByLabel('Phone number').fill('+91 98111 22334');
  await page.getByLabel('Email (optional)').fill('meera.z@example.test');
  await page.getByLabel('Address (optional)').fill('14 Garden Road');
  await page.getByLabel('The patient agrees to be contacted').check();
  await page.getByRole('button', { name: 'Register patient' }).click();

  // The server assigned the MRN.
  await expect(heading(page, 'Patient registered')).toBeVisible();
  await expect(page.getByText('MRN-PTH-12001')).toBeVisible();
  await page.getByRole('link', { name: 'Back to the patient list' }).click();
  await expect(count(page)).toHaveText('12001 patients');

  // Find. The search text never goes into the address.
  await search(page, 'zachariah');
  const found = page.getByRole('link', { name: 'Meera Zachariah', exact: true });
  await expect(found).toBeVisible();
  await expect(count(page)).toHaveText('1 patient');
  expect(new URL(page.url()).search).toBe('');
  // Sensitive values are masked in the list.
  await expect(page.getByRole('main')).not.toContainText('98111 22334');
  await expect(page.getByRole('main')).not.toContainText('MRN-PTH-12001');

  // Open.
  await found.click();
  await expect(heading(page, 'Meera Zachariah')).toBeVisible();
  await expect(page.getByText('MRN-PTH-12001')).toBeVisible();
  const details = page.getByRole('tabpanel');
  await expect(details).toContainText('+91 98111 22334');
  await expect(details).toContainText('meera.z@example.test');
  await expect(details).toContainText('14 Garden Road');
  await expect(details).toContainText('Agreed, recorded');
  await expectNoSidewaysScroll(page);

  // Change.
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(heading(page, 'Edit Meera Zachariah')).toBeVisible();
  await page.getByLabel('Last name').fill('Zachariah-Nair');
  await page.getByLabel('Address (optional)').fill('2 Lake View');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(heading(page, 'Meera Zachariah-Nair')).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('2 Lake View');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // The list shows the new name.
  await page.getByRole('link', { name: 'Back to the patient list' }).click();
  await search(page, 'zachariah-nair');
  await expect(page.getByRole('link', { name: 'Meera Zachariah-Nair', exact: true })).toBeVisible();
  await expect(count(page)).toHaveText('1 patient');
});

test('a duplicate is flagged before a second record is made', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Patients');
  await page.getByRole('link', { name: 'Register a patient' }).click();

  // The same name and date of birth as the first patient in the register.
  await page.getByLabel('First name').fill('Asha');
  await page.getByLabel('Last name').fill('Verma1');
  await page.getByLabel('Date of birth').fill('1950-01-01');
  await page.getByLabel('Gender').selectOption({ label: 'Female' });
  await page.getByLabel('Phone number').fill('+91 90000 00000');
  await page.getByRole('button', { name: 'Register patient' }).click();

  await expect(heading(page, 'This patient may already be registered')).toBeVisible();
  // The match is masked: enough to recognise the person, not to read their details.
  await expect(page.getByRole('main')).not.toContainText('MRN-PTH-00001');
  await expect(page.getByRole('main')).not.toContainText('98000 10000');

  // Going back keeps what was typed.
  await page.getByRole('button', { name: 'Back to the form' }).click();
  await expect(page.getByLabel('Last name')).toHaveValue('Verma1');
});

test('patients of one hospital are never shown in another', async ({ page }) => {
  // A doctor who works at both hospitals.
  await page.goto('/?mockUser=user_doctor');
  await page.getByRole('button', { name: 'Sample Hospital' }).click();
  await expect(heading(page, 'Hospital management system')).toBeVisible();

  await goTo(page, 'Patients');
  await expect(count(page)).toHaveText('12000 patients');
  await page.getByRole('link', { name: 'Asha Verma1', exact: true }).click();
  await expect(page.getByText('MRN-PTH-00001')).toBeVisible();

  // Switching hospital leaves the record and returns home: nothing of it stays on screen.
  await page
    .getByRole('combobox', { name: 'Hospital' })
    .selectOption({ label: 'Riverside Clinic' });
  await expect(heading(page, 'Hospital management system')).toBeVisible();
  await expect(page.getByText('MRN-PTH-00001')).toHaveCount(0);

  // The clinic has its own, much smaller register.
  await goTo(page, 'Patients');
  await expect(count(page)).toHaveText('40 patients');
  await page.getByRole('link', { name: 'Asha Verma1', exact: true }).click();
  await expect(page.getByText('MRN-PTC-00001')).toBeVisible();
  await expect(page.getByText('MRN-PTH-00001')).toHaveCount(0);

  // The address of a hospital patient shows nothing of them at the clinic, to read or to edit.
  await navigateInApp(page, '/patients/pth_00001');
  await expect(heading(page, 'Patient not found')).toBeVisible();
  await navigateInApp(page, '/patients/pth_00001/edit');
  await expect(heading(page, 'Patient not found')).toBeVisible();
  await expect(page.getByText(/MRN-PTH/)).toHaveCount(0);
});

/** Types into a field reached with the keyboard: focus, then keys, as a person would. */
async function typeInto(page: Page, label: string, text: string) {
  await page.getByLabel(label).focus();
  await page.keyboard.type(text);
}

test('register, find, open and change a patient with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Patients');
  await page.getByRole('link', { name: 'Register a patient' }).focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Register a patient')).toBeVisible();

  // Sent empty: focus goes to the first field to fix, which says it is required.
  const first = page.getByLabel('First name');
  await expect(first).toHaveAttribute('aria-required', 'true');
  await page.getByRole('button', { name: 'Register patient' }).focus();
  await page.keyboard.press('Enter');
  await expect(first).toBeFocused();
  await page.keyboard.type('Ishaan');
  await typeInto(page, 'Last name', 'Quraishi');
  await page.getByLabel('Date of birth').fill('1979-11-02');
  await page.getByLabel('Gender').selectOption({ label: 'Male' });
  await typeInto(page, 'Phone number', '+91 98222 33445');
  await page.getByLabel('The patient agrees to be contacted').focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Register patient' }).focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Patient registered')).toBeVisible();

  // Find and open.
  await page.getByRole('link', { name: 'Back to the patient list' }).focus();
  await page.keyboard.press('Enter');
  await typeInto(page, 'Search patients', 'quraishi');
  await expect(count(page)).toHaveText('1 patient');
  const found = page.getByRole('link', { name: 'Ishaan Quraishi', exact: true });
  await found.focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Ishaan Quraishi')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');

  // Change, and hear it saved without losing the place.
  await page.getByRole('link', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Edit Ishaan Quraishi')).toBeVisible();
  await page.getByLabel('Address (optional)').focus();
  await page.keyboard.type('9 Hill Street');
  await page.getByRole('button', { name: 'Save changes' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Your changes were saved.' }),
  ).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText('9 Hill Street');
  await expectNoAxeViolations(page);
});
