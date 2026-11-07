import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The role list (#133) in a real browser. It is a desktop-only screen (CLAUDE.md, Responsive
 * Design): a narrower display gets the notice, which must fit the screen too. The keyboard task
 * is adding a custom role and deleting it, with focus visible at each step.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

test('narrow displays get the notice, and it fits the screen', async ({ page }) => {
  test.skip(isDesktop(page), 'Checked at tablet and phone width.');
  await page.goto('/');
  await goTo(page, 'Roles');
  await expect(
    page.getByRole('heading', { name: 'This screen needs a wider display' }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('add a custom role and delete it from the keyboard', async ({ page }) => {
  test.skip(!isDesktop(page), 'The role list is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Roles');
  await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
  await expect(status(page, '4 roles')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // A built-in role is shown and protected.
  await expect(page.getByRole('button', { name: /^Delete.*Admin/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  const add = page.getByRole('button', { name: 'Add role' });
  await add.focus();
  await page.keyboard.press('Enter');
  const name = page.getByRole('textbox', { name: /^Name/ });
  await expect(name).toBeFocused();
  await name.fill('Ward clerk');
  await page.keyboard.press('Enter');
  await expect(status(page, 'Added Ward clerk.')).toBeVisible();
  await expect(page.getByRole('row', { name: /^Ward clerk/ })).toBeVisible();

  const remove = page.getByRole('button', { name: /^Delete.*Ward clerk/ });
  await remove.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Delete Ward clerk?' });
  await expect(dialog.getByRole('button', { name: 'Keep role' })).toBeFocused();
  await expectNoAxeViolations(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(status(page, 'Deleted Ward clerk.')).toBeVisible();
  await expect(page.getByRole('row', { name: /^Ward clerk/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test('change what a role may do from the keyboard, with focus visible at each step', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'The permission matrix is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Roles');
  await expect(status(page, '4 roles')).toBeVisible();

  const open = page.getByRole('button', { name: /^Permissions.*Doctor/ });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Permissions of Doctor', level: 1 }),
  ).toBeVisible();
  await expect(status(page, 'No changes.')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // A checkbox takes Space, and shows where the keyboard is.
  const remove = page.getByRole('checkbox', { name: /patient:delete$/ });
  await remove.focus();
  await expect(remove).toBeFocused();
  await expect(remove).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(remove).toBeChecked();
  await expect(status(page, '1 unsaved change.')).toBeVisible();

  // A scope list is a native select, changed with the arrow keys.
  const scope = page.getByRole('combobox', { name: 'Scope of appointment:read' });
  await scope.focus();
  await page.keyboard.press('ArrowDown');
  await expect(status(page, '2 unsaved changes.')).toBeVisible();

  const save = page.getByRole('button', { name: 'Save permissions' });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(status(page, 'Saved the permissions of Doctor.')).toBeVisible();
  // Focus stays on the button that was used, and the status line is announced.
  await expect(save).toBeFocused();
  await expectNoAxeViolations(page);
});

test('the role that manages roles cannot lose that, and says why', async ({ page }) => {
  test.skip(!isDesktop(page), 'The permission matrix is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Roles');
  await page.getByRole('button', { name: /^Permissions.*Admin/ }).click();
  const manage = page.getByRole('checkbox', { name: /role:manage$/ });
  await expect(manage).toHaveAttribute('aria-disabled', 'true');
  await manage.focus();
  await page.keyboard.press('Space');
  await expect(manage).toBeChecked();
  await expect(manage).toHaveAccessibleDescription(/cannot take away your own ability/);
});
