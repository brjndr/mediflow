import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The service and tariff catalog in a real browser, against the mock backend. It is master data,
 * so a desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of
 * adding a service and changing its price, and below that the notice that says so.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const field = (page: Page, name: RegExp) => page.getByRole('textbox', { name });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('add a service, then change its price without touching the old one', async ({ page }) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Services and prices');
  await expect(heading(page, 'Services and prices')).toBeVisible();
  await expect(status(page, '31 services')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Add a service with its first price.
  await page.getByRole('link', { name: 'Add a service' }).click();
  await expect(heading(page, 'Add a service')).toBeVisible();
  await field(page, /^Code/).fill('PHY-001');
  await field(page, /^Name/).fill('Physiotherapy session');
  await page.getByRole('combobox', { name: /^Category/ }).selectOption({ label: 'Procedure' });
  await page.getByRole('combobox', { name: /^Tax class/ }).selectOption({ label: 'Exempt' });
  await field(page, /^Price from today/).fill('1,350.50');
  await page.getByRole('button', { name: 'Add service' }).click();

  await expect(heading(page, 'Physiotherapy session')).toBeVisible();
  await expect(page.getByText('₹1,350.50')).toBeVisible();
  await expect(page.getByText('In force', { exact: true })).toBeVisible();

  // A new price from a later date: the first one stays, with an end.
  await field(page, /^Price \(/).fill('1500');
  await page.getByLabel(/^From/).fill('2099-06-01');
  await page.getByRole('button', { name: 'Set price' }).click();
  await expect(status(page, /^The price from .* was set\.$/)).toBeVisible();
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('₹1,350.50')).toBeVisible();
  await expect(page.getByText('₹1,500.00')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // It can still be withdrawn, since it has not started.
  await page
    .getByRole('button', { name: /^Withdraw/ })
    .first()
    .click();
  await expect(status(page, 'The scheduled price was withdrawn.')).toBeVisible();
  await expect(page.getByText('₹1,500.00')).toHaveCount(0);

  // The service is in the catalog, at the price in force today.
  await page.getByRole('link', { name: 'Back to the list of services' }).click();
  await page.getByRole('searchbox', { name: 'Search services' }).fill('PHY-001');
  await expect(page.getByRole('link', { name: 'Physiotherapy session' })).toBeVisible();
  await expect(page.getByText('₹1,350.50')).toBeVisible();
});

test('below desktop width the catalog says it needs a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Services and prices');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Services and prices')).toHaveCount(0);
  // Inside the shell, and fitting the width it was given.
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});
