import { expect, test, type Page } from '@playwright/test';

/**
 * The foundation behaviours in a real browser, end to end against the mock backend: choosing and
 * switching hospital, feature flags, and permission-gated actions. The unit suites cover the
 * edge cases; these prove the pieces work together outside a simulated DOM.
 *
 * `?mockUser=` picks who the mock backend treats as signed in (see src/mocks/browser.ts). A full
 * page load resets the mock, so navigation after the first load is done inside the app.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const notices = (page: Page) => page.getByRole('main').getByRole('heading', { level: 2 });

/** Goes to an address the way a link inside the app does, without reloading the page. */
async function navigateInApp(page: Page, path: string) {
  // Passed as source text: this file is type-checked for Node, which has no `window`.
  await page.evaluate(
    `window.history.pushState({}, '', ${JSON.stringify(path)});
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
}

test('a doctor at two hospitals sees each hospital’s own modules and data', async ({ page }) => {
  await page.goto('/?mockUser=user_doctor');

  // Works at two hospitals and has not picked one: the picker stands in for the app.
  await expect(page.getByRole('heading', { name: 'Choose a hospital' })).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sample Hospital' }).click();

  // At the hospital the notices module is on.
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await sidebar(page).getByRole('link', { name: 'Notices' }).click();
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await expect(notices(page).first()).toHaveText('Hospital notice 1');
  await expect(notices(page)).toHaveCount(25);

  // A doctor may read notices but not archive them: the action is not offered.
  await expect(page.getByRole('button', { name: /^Archive/ })).toHaveCount(0);

  // Switch to the clinic, where the module is off.
  await page
    .getByRole('combobox', { name: 'Hospital' })
    .selectOption({ label: 'Riverside Clinic' });
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Hospital' })).toHaveValue('tenant_2');
  await expect(page).toHaveURL(/\/$/);
  await expect(sidebar(page).getByRole('link', { name: 'Notices' })).toHaveCount(0);
  // Nothing from the first hospital is left on screen.
  await expect(page.getByText(/Hospital notice/)).toHaveCount(0);

  // Going to the module's address directly does not get around the flag.
  await navigateInApp(page, '/notices');
  await expect(
    page.getByRole('heading', { name: 'You do not have access to this page' }),
  ).toBeVisible();
  await expect(page.getByText(/Hospital notice/)).toHaveCount(0);

  // Back at the hospital, the module and its data are there again.
  await page.getByRole('combobox', { name: 'Hospital' }).selectOption({ label: 'Sample Hospital' });
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await sidebar(page).getByRole('link', { name: 'Notices' }).click();
  await expect(notices(page).first()).toHaveText('Hospital notice 1');
});

test('an admin is offered the action a read-only role is not, and it works', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('link', { name: 'Notices' }).click();
  await expect(notices(page)).toHaveCount(25);
  await expect(page.getByRole('button', { name: /^Archive/ })).toHaveCount(25);

  await page.getByRole('button', { name: 'Archive “Hospital notice 1”' }).click();

  await expect(notices(page).first()).toHaveText('Hospital notice 2');
  await expect(page.getByRole('heading', { name: 'Hospital notice 1', exact: true })).toHaveCount(
    0,
  );
});

test('a signed-out visitor is sent to login from any address', async ({ page }) => {
  await page.goto('/notices?mockUser=none');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(sidebar(page)).toHaveCount(0);
});
