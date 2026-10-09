import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** axe in a real browser, which (unlike the unit tests) can also check colour contrast. */
async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
}

test('app loads and reaches the (mock) API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('ok');
});

test('shell, a feature page and the system pages pass axe', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Notices' })
    .click();
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hospital notice 1', exact: true })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.goto('/no/such/page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('the navigation drawer works with the keyboard on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  // The sidebar is hidden at this width; the drawer replaces it.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();

  const openMenu = page.getByRole('button', { name: 'Open menu' });
  await openMenu.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer).toBeVisible();
  await expectNoAxeViolations(page);

  // Escape closes a modal dialog and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(openMenu).toBeFocused();

  // Open again and follow a link with the keyboard.
  await page.keyboard.press('Enter');
  await drawer.getByRole('link', { name: 'Notices' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await expect(drawer).toBeHidden();
});
