import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Responsive and keyboard checks (#565) for the patient's Documents and Consents tabs, the
 * housekeeping task list, the blood bank and document retention, in a real browser against the
 * mock backend, at every width. A full page load resets the mock, so everything after the first
 * load happens inside the app.
 */

async function expectFocusRing(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
}

/**
 * Puts focus on a control the way a keyboard user arrives (a key press after the focus, so the
 * browser treats it as keyboard focus) and checks that the focus ring shows.
 */
async function focusWithKeyboard(page: Page, control: Locator): Promise<void> {
  await control.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(control).toBeFocused();
  await expectFocusRing(page);
}

/** The first patient of the list, opened. */
async function openFirstPatient(page: Page): Promise<void> {
  await page.goto('/');
  await goTo(page, 'Patients');
  await expect(page.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();
  await page.locator('[aria-label="Patients"]').getByRole('link').first().click();
}

/** Moves along the tabs with the arrow keys, from the selected one, until the named tab has focus. */
async function goToTab(page: Page, name: string): Promise<void> {
  await page.locator('[role="tab"][aria-selected="true"]').focus();
  const target = page.getByRole('tab', { name });
  for (let step = 0; step < 12; step += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(target).toBeFocused();
  await expectFocusRing(page);
  await page.keyboard.press('Enter');
  await expect(target).toHaveAttribute('aria-selected', 'true');
}

test('the patient Documents and Consents tabs fit the screen', async ({ page }) => {
  await openFirstPatient(page);

  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Add document' }).click();
  await expect(page.getByLabel('File')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByRole('tab', { name: 'Consents and certificates' }).click();
  await expect(
    page.getByRole('heading', { name: 'Consents and certificates', exact: true }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Record a consent' }).click();
  await expect(page.getByRole('heading', { name: 'Record a consent' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('the housekeeping, blood bank and document retention screens fit the screen', async ({
  page,
}) => {
  await page.goto('/');

  await goTo(page, 'Housekeeping');
  await expect(page.getByRole('heading', { name: 'Housekeeping', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Request a cleaning' }).click();
  await expect(page.getByRole('heading', { name: 'Request a routine cleaning' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await goTo(page, 'Blood bank');
  await expect(page.getByRole('heading', { name: 'Blood bank', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'In stock now' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Register a unit' }).click();
  await expect(page.getByRole('heading', { name: 'Register a collected unit' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await goTo(page, 'Document retention');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('requesting a cleaning is reachable with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Housekeeping');
  const open = page.getByRole('button', { name: 'Request a cleaning' });
  await focusWithKeyboard(page, open);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Request a routine cleaning' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expectFocusRing(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('registering a blood unit is reachable with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Blood bank');
  const open = page.getByRole('button', { name: 'Register a unit' });
  await focusWithKeyboard(page, open);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Register a collected unit' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expectFocusRing(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('adding a document and recording a consent are reachable with the keyboard alone', async ({
  page,
}) => {
  await openFirstPatient(page);
  await goToTab(page, 'Documents');
  const add = page.getByRole('button', { name: 'Add document' });
  await expect(add).toBeVisible();
  await focusWithKeyboard(page, add);
  await page.keyboard.press('Enter');
  await focusWithKeyboard(page, page.getByLabel('File'));

  await goToTab(page, 'Consents and certificates');
  const record = page.getByRole('button', { name: 'Record a consent' });
  await focusWithKeyboard(page, record);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Record a consent' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expectFocusRing(page);
});
