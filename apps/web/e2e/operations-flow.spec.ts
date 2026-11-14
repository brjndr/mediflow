import { expect, test } from '@playwright/test';
import { goTo } from './support';

/**
 * The operations flows end to end (OP-06, #199), in a real browser against the mock backend:
 * a blood unit reserved for a patient and issued, and a bed cleaned after a discharge. A full
 * page load resets the mock, so everything after the first load happens inside the app.
 */
test('reserve a blood unit for a patient and issue it', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Blood bank');
  await expect(page.getByRole('heading', { name: 'Blood bank', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /^Reserve.*BU-0001/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Reserve unit BU-0001' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: /Patient/ }).fill('a');
  await dialog.getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Reserve', exact: true }).click();
  await expect(page.getByText('Unit BU-0001 reserved.')).toBeVisible();

  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption({ label: 'Reserved' });
  await page.getByRole('button', { name: /^Issue.*BU-0001/ }).click();
  await expect(page.getByText('Unit BU-0001 issued.')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption({ label: 'Issued' });
  await expect(page.getByRole('button', { name: /^Record transfusion.*BU-0001/ })).toBeVisible();
});

test('clean a bed after a discharge and make it available', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Housekeeping');
  await expect(page.getByRole('heading', { name: 'Housekeeping', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /^Start.*GW-A-03/ }).click();
  await expect(page.getByText('Cleaning of bed GW-A-03 started.')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption({ label: 'In progress' });
  await page.getByRole('button', { name: /^Finish: bed ready.*GW-A-03/ }).click();
  await expect(page.getByText('Bed GW-A-03 is clean and available.')).toBeVisible();
});
