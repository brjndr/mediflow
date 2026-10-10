import { expect, test } from '@playwright/test';

/**
 * Signing in and out in a real browser, against the mock backend. `?mockUser=none` starts the
 * mock signed out (see src/mocks/browser.ts); the password is the one in src/mocks/db.ts.
 */

const PASSWORD = 'sample-staff-local-only';

test('a wrong password is refused, then the right one opens the app and sign-out closes it', async ({
  page,
}) => {
  await page.goto('/?mockUser=none');

  // Not signed in: the app sends the visitor to the generic login page.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Email').fill('admin@sample-hospital.test');
  await page.getByLabel('Password').fill('not the right password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('The email or password is not correct');
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(page.getByLabel('Password')).toBeFocused();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('Sample Admin');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('someone who works at two hospitals picks one after signing in', async ({ page }) => {
  await page.goto('/?mockUser=none');

  await page.getByLabel('Email').fill('doctor@sample-hospital.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Choose a hospital' })).toBeVisible();
  await page.getByRole('button', { name: 'Riverside Clinic' }).click();
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
});
