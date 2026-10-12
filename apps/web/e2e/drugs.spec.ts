import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The drug and consumable master in a real browser, against the mock backend. Master data, so a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of finding an
 * item in a catalog of thousands and adding one that has near-duplicates, and below that the
 * notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const field = (page: Page, name: RegExp) => page.getByRole('textbox', { name });
const pick = (page: Page, name: RegExp, label: string) =>
  page.getByRole('combobox', { name }).selectOption({ label });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('find an item in a large catalog, and add one that has near-duplicates', async ({ page }) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Drugs and consumables');
  await expect(heading(page, 'Drugs and consumables')).toBeVisible();
  await expect(status(page, '3210 items')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Thousands of items, found by a word of the generic name and one of the brand.
  await page.getByRole('searchbox', { name: 'Search drugs and consumables' }).fill('morph fort');
  await expect(status(page, '20 items')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Morphine' }).first()).toBeVisible();
  await pick(page, /^Form/, 'Injection');
  await expect(status(page, '5 items')).toBeVisible();

  // Add a new brand of something the list already has.
  await page.getByRole('link', { name: 'Add an item' }).click();
  await expect(heading(page, 'Add an item')).toBeVisible();
  await pick(page, /^Type/, 'Medicine');
  await field(page, /^Generic name/).fill('Paracetamol');
  await field(page, /^Brand/).fill('Feverex');
  await pick(page, /^Form/, 'Tablet');
  await field(page, /^Strength/).fill('500 mg');
  await pick(page, /^Tax class/, 'Reduced rate');
  await page.getByRole('button', { name: 'Add item' }).click();

  // The list has the same medicine in the same form: say so before adding another.
  await expect(heading(page, '10 items like this are already in the list')).toBeFocused();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Add it anyway' }).click();

  await expect(heading(page, 'Paracetamol')).toBeVisible();
  await expect(page.getByText('Feverex · Tablet · 500 mg')).toBeVisible();

  // Change it, then find it in the list.
  await page.getByRole('button', { name: 'Edit details' }).click();
  await field(page, /^Unit/).fill('strip of 15');
  await page.getByRole('button', { name: 'Save item' }).click();
  await expect(status(page, 'The item was saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to the list of drugs and consumables' }).click();
  await page.getByRole('searchbox', { name: 'Search drugs and consumables' }).fill('feverex');
  await expect(status(page, '1 item')).toBeVisible();
});

test('below desktop width the drug master says it needs a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Drugs and consumables');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Drugs and consumables')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
