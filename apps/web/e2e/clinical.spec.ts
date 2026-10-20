import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The consultation in a real browser against the mock backend, at every supported width: started
 * from the token being served, a note written, saved on the server and signed with the keyboard
 * alone, with focus visible at each step and never left on the page.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

/** Whether the focused element shows its focus ring, as the keyboard sees it. */
const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

test('start a consultation and sign a note with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'OPD queue');
  await expect(page.getByRole('heading', { name: 'OPD queue', exact: true })).toBeVisible();
  const start = page.getByRole('button', { name: 'Start consultation, token 1' });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Consultation', exact: true })).toBeVisible();
  await expect(page.getByText('No notes yet.')).toBeVisible();

  const write = page.getByRole('button', { name: 'Write a note' });
  await write.focus();
  await page.keyboard.press('Enter');
  // The new draft's heading takes focus; the toolbar is one Tab stop, then the text.
  await expect(page.getByRole('heading', { name: 'Your draft' })).toBeFocused();
  // The editor loads on demand.
  const editor = page.getByRole('textbox', { name: 'Note' });
  await expect(editor).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button').first(),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Cough for three days. Advised rest and fluids.');
  // Leaving the editor saves the draft on the server.
  await page.keyboard.press('Tab');
  await expect(page.getByText(/^Draft saved at /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign note' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(
    0,
  );
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Enter');
  // The draft goes; focus moves to what was done.
  const signed = page.getByText('Note signed.');
  await expect(signed).toBeFocused();
  await expect(page.getByText('Cough for three days. Advised rest and fluids.')).toBeVisible();
  await expectNoAxeViolations(page);
});

test('write a prescription with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Prescriptions' })).toBeVisible();
  await expect(page.getByText('Paracetamol 500 mg (ParaCare)')).toBeVisible();

  const write = page.getByRole('button', { name: 'Write a prescription' });
  await write.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'New prescription' })).toBeFocused();

  // The medicine is searched on the server and chosen from the list with the arrows and Enter.
  await page.keyboard.press('Tab');
  const medicine = page.getByRole('combobox', { name: 'Medicine' });
  await expect(medicine).toBeFocused();
  await page.keyboard.type('azithro');
  await expect(
    page.getByRole('listbox', { name: 'Medicine' }).getByRole('option').first(),
  ).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const change = page.getByRole('button', { name: /^Change the medicine, now Azithromycin/ });
  await expect(change).toBeFocused();
  expect(await focusVisible(page)).toBe(true);

  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: /^Dose/ })).toBeFocused();
  await page.keyboard.type('1 tablet');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: /^Route/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.type('1-0-0');
  await page.keyboard.press('Tab');
  await page.keyboard.type('3');
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const submit = page.getByRole('button', { name: 'Write the prescription' });
  await submit.focus();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  // The form goes; focus moves to what was done.
  await expect(page.getByText('Prescription written.')).toBeFocused();
  await expect(page.getByText(/^Azithromycin/)).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(
    0,
  );
  await expectNoAxeViolations(page);
});
