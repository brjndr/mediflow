import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The theatre dialogs on a started surgery (#918), in a real browser against the mock backend, at
 * every supported width: start the seeded surgery, then open the checklist and anaesthesia, the
 * operation note and the recovery dialogs, and write a recovery note with the keyboard alone. Row
 * actions are named "<action>: <row label>", so the same locators fit the table and the phone's
 * cards. A full page load resets the mock, so all of it happens inside the app.
 */

const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

async function openStartedSurgery(page: Page) {
  await page.goto('/');
  await goTo(page, 'Operation theatre');
  await expect(page.getByRole('heading', { name: 'Operation theatre', level: 1 })).toBeVisible();
  // The mock's surgery is on a fixed day.
  await page.getByLabel('Day', { exact: true }).fill('2030-01-15');
  await page.getByRole('button', { name: /^Start surgery/ }).click();
  await expect(page.getByText('Surgery started: Appendicectomy.')).toBeVisible();
}

test('the checklist, operation and recovery dialogs open on a started surgery', async ({
  page,
}) => {
  await openStartedSurgery(page);

  for (const [action, title] of [
    ['Checklist and anaesthesia', 'Checklist and anaesthesia: Appendicectomy'],
    ['Operation note and stock', 'Operation: Appendicectomy'],
    ['Recovery and orders', 'Recovery: Appendicectomy'],
  ] as const) {
    const opener = page.getByRole('button', { name: new RegExp(`^${action}`) });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expectNoSidewaysScroll(page);
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Focus goes back to the button that opened it.
    await expect(opener).toBeFocused();
    expect(await focusVisible(page)).toBe(true);
  }
});

test('write a recovery note with the keyboard alone', async ({ page }) => {
  await openStartedSurgery(page);
  await page.getByRole('button', { name: /^Recovery and orders/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Recovery: Appendicectomy' });
  await expect(dialog.getByText('No recovery notes have been written yet.')).toBeVisible();

  const note = dialog.getByRole('textbox', { name: /^Note/ });
  await note.focus();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('Awake, pain controlled');
  await page.keyboard.press('Tab');
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('3');
  await dialog.getByRole('button', { name: 'Add note' }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Recovery note added.')).toBeVisible();
  await expect(
    dialog.getByRole('list', { name: 'Recovery notes' }).getByText('Awake, pain controlled'),
  ).toBeVisible();
});
