import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * Diagnosis and procedure codes in a real browser, against the mock backend. Master data, so a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of searching
 * a code set, marking a favourite and finding it first in the search box; below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('search a code set, mark a favourite, and find it first in the search box', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Diagnosis and procedure codes');
  await expect(heading(page, 'Diagnosis and procedure codes')).toBeVisible();
  await expect(status(page, '1267 codes')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Found by words of the title, on the server.
  await page.getByRole('searchbox', { name: 'Search codes' }).fill('asthma');
  await expect(status(page, '1 code')).toBeVisible();
  await page.getByRole('button', { name: 'Add to favourites: J45.9', exact: true }).click();
  await expect(status(page, 'J45.9 is now a favourite.')).toBeVisible();

  // The search box offers the favourites before anything is typed.
  const box = page.getByRole('combobox', { name: 'Find a diagnosis' });
  await box.click();
  await expect(page.getByRole('option', { name: /Asthma, unspecified/ })).toBeVisible();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(4);
  await expectNoSidewaysScroll(page);

  // Typed, then chosen with the keyboard.
  await box.pressSequentially('pneu');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await box.press('Enter');
  await expect(status(page, 'Chosen: J18.9 Pneumonia, unspecified')).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);

  // And with a click.
  await box.fill('fever');
  await page.getByRole('option', { name: /Dengue fever/ }).click();
  await expect(status(page, 'Chosen: A90 Dengue fever')).toBeVisible();
});

test('below desktop width the codes say they need a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Diagnosis and procedure codes');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Diagnosis and procedure codes')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
