import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The import centre in a real browser, against the mock backend. The bulk import centre is a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of loading a
 * file of services, from the file to its records written, and below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

const FILE = [
  'Code,Name,Category,Tax class,Price',
  'CONS-1,General consultation,consultation,exempt,500',
  'CONS-2,Specialist consultation,consultation,exempt,"1,250.50"',
].join('\n');

test('load a file of services, check it and write it', async ({ page }) => {
  test.skip(!isDesktop(page), 'The import centre is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Import centre');
  await expect(heading(page, 'Import centre')).toBeVisible();
  await expect(page.getByText('Nothing has been imported yet.')).toBeVisible();

  await page.getByRole('link', { name: 'New import' }).click();
  await page.getByRole('combobox', { name: 'What the file holds' }).selectOption({
    label: 'Services and prices',
  });
  await page.getByLabel('CSV file').setInputFiles({
    name: 'services.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(FILE),
  });
  await expect(status(page, '2 rows read from the file.')).toBeVisible();
  // The columns were matched by their titles.
  await expect(page.getByRole('combobox', { name: /^Price/ })).toHaveValue('4');
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Send and check' }).click();
  await expect(status(page, 'Every row can be written.')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Write the records' }).click();
  await expect(status(page, '2 records were written.')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: 'Back to the import centre' }).click();
  const batches = page.getByRole('table', { name: 'Imports' });
  await expect(batches.getByRole('link', { name: 'Services and prices' })).toBeVisible();
});

test('below desktop width the import centre says it needs a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Import centre');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Import centre')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
