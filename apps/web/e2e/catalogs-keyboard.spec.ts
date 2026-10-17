import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoAxeViolations, goTo } from './support';

/**
 * The master data screens and the import centre with the keyboard alone (#348). They are
 * desktop-only (CLAUDE.md, Responsive Design), so these run at desktop width. Each checks that
 * focus follows what opens and closes, and never falls to the page.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

/** Focus, then Enter, as a person reaching a control with the keyboard would. */
async function press(page: Page, control: Locator) {
  await control.focus();
  await page.keyboard.press('Enter');
}

async function expectFocusNotLost(page: Page) {
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
}

for (const [nav, path] of [
  ['Services and prices', 'services'],
  ['Drugs and consumables', 'drugs'],
  ['Lab tests', 'lab-tests'],
  ['Wards and beds', 'wards'],
] as const) {
  test(`${path}: edit a record from the keyboard and come back to Edit`, async ({ page }) => {
    test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
    await page.goto('/');
    await goTo(page, nav);
    await press(page, page.locator('main table tbody a').first());
    await expect(page).toHaveURL(new RegExp(`/${path}/[^/]+$`));

    const edit = page.getByRole('button', { name: 'Edit details' });
    await press(page, edit);
    // The form takes the place of the details: the keyboard goes to the section's heading.
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeFocused();
    await expectNoAxeViolations(page);
    await press(page, page.getByRole('button', { name: 'Cancel', exact: true }));
    await expect(edit).toBeFocused();
  });
}

test('wards: a room form opens on its heading and gives focus back to its button', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Wards and beds');
  await press(page, page.locator('main table tbody a').first());
  const add = page.getByRole('button', { name: 'Add a room', exact: true });
  await press(page, add);
  await expect(page.getByRole('heading', { name: 'Add a room', exact: true })).toBeFocused();
  await press(page, page.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(add).toBeFocused();
});

test('codes: mark a favourite from the keyboard and keep the place', async ({ page }) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Diagnosis and procedure codes');
  // One that is not a favourite yet: the favourites come first, with this button unavailable.
  const add = page
    .locator('button[aria-label^="Add to favourites: "]:not([aria-disabled])')
    .first();
  const code = ((await add.getAttribute('aria-label')) ?? '').replace('Add to favourites: ', '');
  await press(page, add);
  // The row moves to the top with the favourites: the keyboard goes to what was done.
  await expect(status(page, `${code} is now a favourite.`)).toBeVisible();
  await expectFocusNotLost(page);
  await expectNoAxeViolations(page);
});

test('imports: send, check and write a file with the keyboard, told how it ends', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'The import centre is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Import centre');
  await press(page, page.getByRole('link', { name: 'New import' }));
  await page
    .getByRole('combobox', { name: 'What the file holds' })
    .selectOption({ label: 'Services and prices' });
  // Choosing a file opens the system's own picker, which the browser drives for us here.
  await page.getByLabel('CSV file').setInputFiles({
    name: 'services.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Code,Name,Category,Tax class,Price',
        'KB-1,Keyboard consultation,consultation,exempt,500',
      ].join('\n'),
    ),
  });
  await expect(status(page, '1 row read from the file.')).toBeVisible();
  await press(page, page.getByRole('button', { name: 'Send and check' }));
  await expect(status(page, 'Every row can be written.')).toBeVisible({ timeout: 10_000 });

  // Writing takes the buttons away: focus goes to the line that says how it ended.
  await press(page, page.getByRole('button', { name: 'Write the records' }));
  const written = status(page, '1 record was written.');
  await expect(written).toBeVisible({ timeout: 10_000 });
  await expect(written).toBeFocused();
  await expectNoAxeViolations(page);
});
