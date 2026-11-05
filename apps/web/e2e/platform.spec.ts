import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll } from './support';

/**
 * The platform area is not a registered feature, so the specs that walk the registry do not reach
 * it. This one walks the hospitals list and the create-hospital wizard at every width, with the
 * keyboard, and checks them with axe. The mock starts as the platform admin with an authenticator.
 */
const START = '/platform/hospitals?mockUser=user_platform_admin&mockMfa=on';

test('the hospitals list fits the screen and passes axe', async ({ page }) => {
  await page.goto(START);
  await expect(page.getByRole('heading', { name: 'Hospitals', level: 1 })).toBeVisible();
  await expect(page.getByText('City General Hospital')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('a hospital is created with the keyboard, step by step', async ({ page }) => {
  await page.goto(START);
  await page.getByRole('link', { name: 'New hospital' }).click();
  await expect(page.getByRole('heading', { name: 'New hospital', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByLabel('Hospital name').fill('Lakeview Hospital');
  await expect(page.getByLabel('Slug')).toHaveValue('lakeview-hospital');
  // Enter goes on to the next step, and focus starts at its heading.
  await page.getByLabel('Hospital name').press('Enter');
  const second = page.getByRole('heading', { name: 'Language, clock and look' });
  await expect(second).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByLabel('Locale').fill('en-IN');
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByLabel('Currency').selectOption('INR');
  await page.getByRole('button', { name: 'Next' }).press('Enter');
  const third = page.getByRole('heading', { name: 'Modules and limits' });
  await expect(third).toBeFocused();
  await page.getByRole('checkbox', { name: 'Patients' }).check();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Create hospital' }).press('Enter');
  await expect(page.getByText('Hospital Lakeview Hospital was created.')).toBeVisible();
  await expect(page.getByText('lakeview-hospital')).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('a hospital opens from the list; modules and limits are changed with the keyboard', async ({
  page,
}) => {
  await page.goto(START);
  await page.getByRole('link', { name: 'Riverside Clinic' }).click();
  await expect(page.getByRole('heading', { name: 'Riverside Clinic', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const lab = page.getByRole('checkbox', { name: 'Laboratory' });
  await lab.focus();
  await lab.press('Space');
  await expect(lab).toBeChecked();
  await page.getByRole('button', { name: 'Save modules' }).press('Enter');
  await expect(page.getByText('Modules saved.')).toBeVisible();

  await page.getByLabel(/Most staff accounts/).fill('80');
  await page.getByLabel(/Most staff accounts/).press('Enter');
  await expect(page.getByText('Limits saved.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});
