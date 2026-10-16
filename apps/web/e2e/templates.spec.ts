import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Document templates in a real browser, against the mock backend. Master data, so a
 * desktop-only screen (CLAUDE.md, Responsive Design): at desktop width the journey of writing a
 * template with a placeholder, seeing its preview, saving a second version, looking at the
 * first again and redacting it; below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });
const preview = (page: Page) => page.getByRole('region', { name: 'Preview' });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('write a template with a placeholder, preview it, and keep both versions', async ({
  page,
}) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Document templates');
  await expect(heading(page, 'Document templates')).toBeVisible();
  await expect(status(page, '5 templates')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByRole('link', { name: 'Add a template' }).click();
  await expect(heading(page, 'Add a template')).toBeVisible();
  await page.getByRole('combobox', { name: /^Kind/ }).selectOption({ label: 'Clinical note' });
  await page.getByRole('textbox', { name: /^Name/ }).fill('Follow-up note');

  // Typed text, then a placeholder from the list, where the cursor is.
  const text = page.getByRole('textbox', { name: 'Text' });
  await text.click();
  await text.pressSequentially('Reviewed by ');
  await page
    .getByRole('combobox', { name: 'Insert a placeholder' })
    .selectOption({ label: "Doctor's name" });
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(text).toContainText('Reviewed by {{doctor.name}}');
  // The preview reads as a document made from it would.
  await expect(preview(page)).toContainText('Reviewed by Dr Sample Doctor');
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(heading(page, 'Follow-up note')).toBeVisible();
  await expect(page.getByText('Clinical note · Version 1')).toBeVisible();

  // A change is a new version.
  await page.getByRole('button', { name: 'Edit as a new version' }).click();
  const editing = page.getByRole('textbox', { name: 'Text' });
  await editing.click();
  await page.keyboard.press('Control+End');
  await editing.pressSequentially(' on ');
  await page
    .getByRole('combobox', { name: 'Insert a placeholder' })
    .selectOption({ label: "Today's date" });
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await page.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(status(page, 'Saved as version 2.')).toBeVisible();
  await expect(page.getByText('Clinical note · Version 2')).toBeVisible();
  await expect(preview(page)).not.toContainText('{{');

  // The first version is still what it was.
  await page.getByRole('button', { name: 'View: Version 1', exact: true }).click();
  const first = page.getByRole('region', { name: 'Version 1, as it was saved' });
  await expect(first).toContainText('Reviewed by {{doctor.name}}');
  await expect(first).not.toContainText('date.today');
  await expectNoSidewaysScroll(page);

  // What should not have been typed into the first version is removed: its name and its text.
  await expect(page.getByRole('button', { name: 'Redact: Version 2', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redact: Version 1', exact: true }).click();
  const redact = page.getByRole('region', { name: 'Redact Version 1' });
  await expect(redact.getByRole('heading', { name: 'Redact Version 1' })).toBeFocused();
  await redact.getByRole('combobox', { name: /^Reason/ }).selectOption({ label: 'Another reason' });
  await redact.getByRole('button', { name: 'Remove the name and the text' }).click();
  await expect(status(page, 'The name and the text of Version 1 were removed.')).toBeVisible();
  await page.getByRole('button', { name: 'View: Version 1', exact: true }).click();
  await expect(first).toContainText('were removed on');
  await expect(first).not.toContainText('doctor.name');
  await expectNoSidewaysScroll(page);
});

test('below desktop width the templates say they need a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Document templates');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Document templates')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test('write, format and preview a template with the keyboard alone', async ({ page }) => {
  test.skip(!isDesktop(page), 'Master data is a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Document templates');
  await page.getByRole('link', { name: 'Add a template' }).focus();
  await page.keyboard.press('Enter');
  await expect(heading(page, 'Add a template')).toBeVisible();
  await page.getByRole('combobox', { name: /^Kind/ }).selectOption({ label: 'Clinical note' });
  await page.getByRole('textbox', { name: /^Name/ }).focus();
  await page.keyboard.type('Keyboard note');

  // The editor loads on demand; its toolbar can be used once it has.
  await expect(page.getByRole('textbox', { name: 'Text' })).toBeVisible();
  // Tab reaches the toolbar once, the arrows move along it, Tab again reaches the text.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Italic' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  // A format button applies and goes back to the text, to carry on typing.
  await page.keyboard.press('Space');
  const text = page.getByRole('textbox', { name: 'Text' });
  await expect(text).toBeFocused();
  await page.keyboard.type('Seen by ');
  await expect(text.locator('strong')).toHaveText('Seen by');

  // Back to the list of placeholders, before the text: going through it with the arrows puts
  // nothing in, the Insert button does, at the cursor.
  await page.keyboard.press('Shift+Tab');
  const insert = page.getByRole('button', { name: 'Insert', exact: true });
  await expect(insert).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const list = page.getByRole('combobox', { name: 'Insert a placeholder' });
  await expect(list).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(text).toHaveText('Seen by ');
  await list.selectOption({ label: "Doctor's name" });
  await page.keyboard.press('Tab');
  await expect(insert).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(text).toBeFocused();
  await expect(text).toHaveText('Seen by {{doctor.name}}');
  await page.keyboard.type('.');
  await expect(preview(page)).toContainText('Seen by Dr Sample Doctor.');

  // Escape leaves the text for the toolbar, where focus can be seen.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
  await expectNoAxeViolations(page);
});
