import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * Wards, rooms and beds in a real browser, against the mock backend. Master data, so a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of setting up
 * a bed category charged as a bed-day service, a ward with a room and a bed of that category,
 * and taking the bed out of use and back; below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const field = (page: Page, name: RegExp) => page.getByRole('textbox', { name });
const pick = (page: Page, name: RegExp, label: string) =>
  page.getByRole('combobox', { name }).selectOption({ label });
const press = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('set up a bed category, a ward, a room and a bed, and block the bed', async ({ page }) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Wards and beds');
  await expect(heading(page, 'Wards and beds')).toBeVisible();
  await expect(status(page, '30 wards')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A bed category, charged as a bed-day service of the price catalog.
  await page.getByRole('link', { name: 'Bed categories' }).click();
  await expect(heading(page, 'Bed categories')).toBeVisible();
  await expect(page.getByText('Not linked: no bed-day charge')).toBeVisible();
  await press(page, 'Add a bed category');
  await field(page, /^Name/).fill('High dependency');
  await pick(page, /^Charged as/, 'ICU bed day (BED-004)');
  await press(page, 'Add category');
  await expect(status(page, 'High dependency was added.')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A ward, with a room and a bed of that category.
  await page.getByRole('link', { name: 'Back to wards and beds' }).click();
  await page.getByRole('link', { name: 'Add a ward' }).click();
  await field(page, /^Code/).fill('HDU');
  await field(page, /^Name/).fill('High dependency unit');
  await field(page, /^Floor/).fill('3rd floor');
  await pick(page, /^Department/, 'Intensive Care');
  await press(page, 'Add ward');
  await expect(heading(page, 'High dependency unit')).toBeVisible();
  await expect(page.getByText('No rooms yet.')).toBeVisible();

  await press(page, 'Add a room');
  await field(page, /^Room name/).fill('Main hall');
  await press(page, 'Add room');
  await expect(status(page, 'Main hall was added.')).toBeVisible();
  await press(page, 'Add a bed to Main hall');
  await field(page, /^Bed number/).fill('HDU-01');
  await pick(page, /^Bed category/, 'High dependency');
  await press(page, 'Add bed');
  await expect(status(page, 'Bed HDU-01 was added.')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Out of use for a reason, and back.
  await press(page, 'Block: HDU-01');
  await field(page, /^Reason/).fill('Monitor being replaced');
  await press(page, 'Block bed');
  await expect(page.getByText('Blocked: Monitor being replaced')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Block: HDU-01', exact: true })).toBeDisabled();
  await press(page, 'Put back in use: HDU-01');
  await expect(status(page, 'Bed HDU-01 is available again.')).toBeVisible();

  // The ward is in the list, with its room and bed counted.
  await page.getByRole('link', { name: 'Back to the list of wards' }).click();
  await page.getByRole('searchbox', { name: 'Search wards' }).fill('hdu');
  await expect(status(page, '1 ward')).toBeVisible();
  await expect(page.getByRole('link', { name: 'High dependency unit' })).toBeVisible();
});

test('below desktop width the wards say they need a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Wards and beds');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Wards and beds')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
