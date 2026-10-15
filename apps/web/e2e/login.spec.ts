import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './support';

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

test('signing out in one tab signs out the other', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('/');
  await second.goto('/notices');
  await expect(second.getByRole('heading', { name: 'Staff notices' })).toBeVisible();

  await first.getByRole('button', { name: 'Sign out' }).click();
  await expect(first.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The other tab follows at once, without being touched, and shows none of what it had loaded.
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(second.getByRole('status')).toHaveText('You signed out in another tab.');
  await expect(second.getByText(/Hospital notice/)).toHaveCount(0);
});

test('sign in with the keyboard alone, led to the field to fill', async ({ page }) => {
  await page.goto('/?mockUser=none');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // Sent empty: focus goes to the first field, which says it is required.
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('aria-required', 'true');
  await page.getByRole('button', { name: 'Sign in' }).focus();
  await page.keyboard.press('Enter');
  await expect(email).toBeFocused();
  await page.keyboard.type('admin@sample-hospital.test');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
});

test('ask for a new password with the keyboard alone', async ({ page }) => {
  await page.goto('/?mockUser=none');
  await page.getByRole('link', { name: 'Forgot your password?' }).focus();
  await page.keyboard.press('Enter');
  // Each step of the page puts focus on its own title, so a screen reader starts there.
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeFocused();
  await page.getByLabel('Email').focus();
  await page.keyboard.type('admin@sample-hospital.test');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused();
  await expectNoAxeViolations(page);
});

test('the idle warning is answered from the keyboard, the safe way round', async ({ page }) => {
  await page.clock.install();
  await page.goto('/notices');
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();

  // The sample hospital signs out after 30 minutes; the warning shows for the last one.
  await page.clock.fastForward('29:10');
  const warning = page.getByRole('alertdialog', { name: 'Are you still there?' });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAccessibleDescription(/You will be signed out in \d+ seconds/);
  // Staying has focus: Enter pressed out of habit keeps the session.
  await expect(page.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(warning).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();

  // Escape answers it the same way.
  await page.clock.fastForward('29:10');
  await expect(warning).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(warning).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
});

test('choose and change hospital from the keyboard, and hear where you are', async ({ page }) => {
  // A doctor who works at both hospitals chooses one first.
  await page.goto('/?mockUser=user_doctor');
  await page.getByRole('button', { name: 'Sample Hospital' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();

  const switcher = page.getByRole('combobox', { name: 'Hospital' });
  await switcher.focus();
  await switcher.selectOption({ label: 'Riverside Clinic' });
  await expect(
    page.getByRole('status').filter({ hasText: 'Now working at Riverside Clinic.' }),
  ).toBeAttached();
  await expect(switcher.locator('option:checked')).toHaveText('Riverside Clinic');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
});
