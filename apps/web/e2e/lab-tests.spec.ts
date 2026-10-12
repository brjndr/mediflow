import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The lab test catalog in a real browser, against the mock backend. Master data, so a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of adding a
 * test, giving it reference ranges by age and sex and looking up the range for a patient, and
 * below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const field = (page: Page, name: RegExp) => page.getByRole('textbox', { name });
const pick = (page: Page, name: RegExp, label: string) =>
  page.getByRole('combobox', { name }).selectOption({ label });
const range = (page: Page, number: number) => page.getByRole('group', { name: `Range ${number}` });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('add a test, set its ranges by age and sex, and look up the range for a patient', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Lab tests');
  await expect(heading(page, 'Lab tests')).toBeVisible();
  await expect(status(page, '47 tests')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Found by its code, and narrowed to the panels.
  await page.getByRole('searchbox', { name: 'Search lab tests' }).fill('lipid');
  await expect(status(page, '1 test')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lipid profile' })).toBeVisible();

  // A new numeric test, charged as a laboratory service of the price catalog.
  await page.getByRole('link', { name: 'Add a test' }).click();
  await expect(heading(page, 'Add a test')).toBeVisible();
  await field(page, /^Code/).fill('FERR');
  await field(page, /^Name/).fill('Ferritin');
  await pick(page, /^Section/, 'Biochemistry');
  await pick(page, /^Result is/, 'A number');
  await field(page, /^Unit/).fill('ng/mL');
  await pick(page, /^Sample/, 'Serum');
  await field(page, /^Container/).fill('Gel tube');
  await field(page, /^Turnaround/).fill('24');
  await page.getByRole('searchbox', { name: 'Find a laboratory service' }).fill('thyroid');
  await pick(page, /^Charged as/, 'Thyroid profile (LAB-006)');
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Add test' }).click();

  await expect(heading(page, 'Ferritin')).toBeVisible();
  await expect(page.getByText('FERR · Biochemistry')).toBeVisible();
  await expect(page.getByText('No reference ranges yet.')).toBeVisible();

  // Men and women are read against different ranges.
  await page.getByRole('button', { name: 'Edit ranges' }).click();
  await page.getByRole('button', { name: 'Add a range' }).click();
  await range(page, 1).getByRole('combobox', { name: /^For/ }).selectOption({ label: 'Male' });
  await range(page, 1)
    .getByRole('textbox', { name: /^From age/ })
    .fill('18');
  await range(page, 1)
    .getByRole('textbox', { name: /^Lowest normal/ })
    .fill('30');
  await range(page, 1)
    .getByRole('textbox', { name: /^Highest normal/ })
    .fill('400');
  await page.getByRole('button', { name: 'Add a range' }).click();
  await range(page, 2).getByRole('combobox', { name: /^For/ }).selectOption({ label: 'Male' });
  await range(page, 2)
    .getByRole('textbox', { name: /^From age/ })
    .fill('40');
  await range(page, 2)
    .getByRole('textbox', { name: /^Lowest normal/ })
    .fill('30');
  await page.getByRole('button', { name: 'Save ranges' }).click();
  // Two ranges for men that share ages are refused before anything is sent.
  await expect(
    range(page, 2).getByText(/Another range for the same people already covers some of these ages/),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);

  await range(page, 2).getByRole('combobox', { name: /^For/ }).selectOption({ label: 'Female' });
  await range(page, 2)
    .getByRole('textbox', { name: /^From age/ })
    .fill('18');
  await range(page, 2)
    .getByRole('textbox', { name: /^Lowest normal/ })
    .fill('15');
  await range(page, 2)
    .getByRole('textbox', { name: /^Highest normal/ })
    .fill('150');
  await page.getByRole('button', { name: 'Save ranges' }).click();
  await expect(status(page, 'The reference ranges were saved.')).toBeVisible();
  await expect(page.getByText('30 to 400 ng/mL')).toBeVisible();

  // The range a result would be read against, for a woman of 30 and for a child.
  await field(page, /^Age/).fill('30');
  await pick(page, /^Sex/, 'Female');
  await page.getByRole('button', { name: 'Find the range' }).click();
  await expect(
    status(page, 'Range used: Female, From 18 years. Normal: 15 to 150 ng/mL.'),
  ).toBeVisible();
  await field(page, /^Age/).fill('10');
  await page.getByRole('button', { name: 'Find the range' }).click();
  await expect(status(page, 'No range covers a patient of this age and sex.')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A panel shows the tests it is made of.
  await page.getByRole('link', { name: 'Back to the list of lab tests' }).click();
  await pick(page, /^Kind/, 'Panel');
  await page.getByRole('link', { name: 'Complete blood count' }).click();
  await expect(
    page.getByRole('list', { name: 'Tests in this panel' }).getByRole('link'),
  ).toHaveCount(6);
});

test('below desktop width the lab test catalog says it needs a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Lab tests');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Lab tests')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
