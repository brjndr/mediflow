import { expect, test } from '@playwright/test';
import { expectNoSidewaysScroll, goTo, gridIsStacked } from './support';

/**
 * The responsive target in CLAUDE.md, checked in a real browser. Every spec runs at a desktop, a
 * tablet and a phone width; this one checks what only shows at a width: that pages fit the
 * screen, that a list becomes cards when there is no room for a table, and that controls are
 * large enough for a finger where the pointer is one.
 */

/** Pixels. The smallest comfortable touch target (WCAG 2.5.5, and both mobile platforms). */
const TOUCH_TARGET = 44;

test('the main screens fit the screen without scrolling sideways', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await goTo(page, 'Notices');
  await expect(page.getByRole('heading', { name: 'Staff notices' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Departments: the list, and the form that opens above it.
  await goTo(page, 'Departments');
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toBeVisible();
  await expect(page.getByText('Cardiology')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Add department' }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Doctors: the list, a profile with its week of working hours, and the add form.
  await goTo(page, 'Doctors');
  await expect(page.getByRole('heading', { name: 'Doctors', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aarav Iyer' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('link', { name: 'Aarav Iyer' }).click();
  await expect(page.getByRole('heading', { name: 'Working hours' })).toBeVisible();
  await expect(page.getByLabel('Monday, session 1: from')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await expect(page.getByRole('textbox', { name: 'Specialization' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('link', { name: 'Back to the doctor list' }).click();
  await page.getByRole('link', { name: 'Add a doctor' }).click();
  await expect(page.getByRole('searchbox', { name: 'Find a staff member' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Staff: the list, the question before deactivating, and the invite screen with its file.
  await goTo(page, 'Staff');
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
  await expect(page.getByText('Aarav Iyer')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Deactivate: Aarav Iyer' }).click();
  await expect(page.getByRole('heading', { name: 'Deactivate Aarav Iyer?' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('link', { name: 'Invite staff' }).click();
  await expect(page.getByRole('heading', { name: 'Invite one person' })).toBeVisible();
  await expect(page.getByLabel('CSV file')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await goTo(page, 'Patients');
  await expect(page.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);

  // A patient's record: the header stacks and the tabs stay inside the width.
  await page.getByRole('link', { name: 'Asha Verma1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asha Verma1' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  // Editing it: one column of fields on a phone.
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit Asha Verma1' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole('link', { name: 'Cancel and go back to the record' }).click();
  await expect(page.getByRole('heading', { name: 'Asha Verma1', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Back to the patient list' }).click();

  await page.getByRole('link', { name: 'Register a patient' }).click();
  await expect(page.getByRole('heading', { name: 'Register a patient' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByRole('link', { name: /^Your account:/ }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('the sign-in page fits the screen', async ({ page }) => {
  await page.goto('/?mockUser=none');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('the patient list is a table where there is room and cards where there is not', async ({
  page,
}) => {
  await page.goto('/');
  await goTo(page, 'Patients');
  await expect(page.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();

  const table = page.getByRole('table', { name: 'Patients' });
  const cards = page.getByRole('list', { name: 'Patients' });
  if (gridIsStacked(page)) {
    await expect(cards.getByRole('listitem').first()).toBeVisible();
    await expect(table).toHaveCount(0);
    // The sort is a list to choose from, since there are no column headers to press.
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toBeVisible();
    // Each card labels its values, as the column headers would.
    await expect(cards.getByRole('listitem').first().getByRole('term').first()).toBeVisible();
  } else {
    await expect(table).toBeVisible();
    await expect(cards).toHaveCount(0);
  }
  await expectNoSidewaysScroll(page);
});

test('controls are large enough for a finger on a touch screen', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'A mouse pointer does not need touch-sized controls.');
  await page.goto('/');
  await goTo(page, 'Patients');
  await expect(page.getByRole('heading', { name: 'Patients', exact: true })).toBeVisible();
  // The list itself has controls (its sort, its Columns menu), so wait for it.
  const list = page.getByRole('list', { name: 'Patients' });
  const table = page.getByRole('table', { name: 'Patients' });
  await expect(list.or(table).first()).toBeVisible();
  await expect(page.getByText('Columns', { exact: true }).first()).toBeVisible();

  // Every control on screen: buttons, selects, text fields, menu summaries, and the links of
  // the navigation and the header. Links inside running text are not targets of their own.
  const sizes = (await page.evaluate(`
    [...document.querySelectorAll('button, select, summary, input:not([type=checkbox]):not([type=radio]), [role=button], nav a, header a')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          what: (element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 40),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      })
  `)) as { what: string; width: number; height: number }[];

  // The header, the search, the page size and the list's own controls at the least.
  expect(sizes.length).toBeGreaterThanOrEqual(6);
  const tooSmall = sizes.filter(
    (control) => control.height < TOUCH_TARGET || control.width < TOUCH_TARGET,
  );
  expect(tooSmall).toEqual([]);
});
