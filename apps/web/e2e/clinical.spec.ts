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

test('print a prescription and the visit summary with the keyboard alone', async ({ page }) => {
  // The browser's own print dialog cannot be driven, so it is counted and closed at once.
  await page.addInitScript(() => {
    const counted = window as Window & { printed?: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed = (counted.printed ?? 0) + 1;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  const printed = () => page.evaluate(() => (window as Window & { printed?: number }).printed);
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  await expect(page.getByText('Paracetamol 500 mg (ParaCare)')).toBeVisible();

  // Reached with the keyboard: from the control before it, Tab.
  const reach = async (target: ReturnType<Page['getByRole']>) => {
    await target.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  };
  const prescription = page.getByRole('button', { name: /^Print the prescription written/ });
  await reach(prescription);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(printed).toBe(1);
  // Focus stays where it was, and the page printed is not left behind.
  await expect(prescription).toBeFocused();
  await expect(page.locator('[data-print-sheet]')).toHaveCount(0);

  const summary = page.getByRole('button', { name: 'Print summary' });
  await reach(summary);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(printed).toBe(2);
  await expect(summary).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});

test('order a lab test and cancel one with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Lab orders' })).toBeVisible();
  const orders = page
    .getByRole('heading', { name: 'Lab orders' })
    .locator('xpath=ancestor::section[1]');
  await expect(orders.getByText('Complete blood count')).toBeVisible();

  // Reached by Tab, as the keyboard would arrive at it.
  const reach = async (target: ReturnType<Page['getByRole']>) => {
    await target.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  };

  // The test is searched on the server and chosen from the list with the arrows and Enter.
  const search = page.getByRole('combobox', { name: 'Test or panel' });
  await reach(search);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('haemoglobin');
  await expect(
    page.getByRole('listbox', { name: 'Test or panel' }).getByRole('option').first(),
  ).toBeVisible();
  // The arrows move to the test wanted, whatever else the search found.
  const wanted = page.getByRole('option', { name: 'Haemoglobin (HB), Single test' });
  await expect(wanted).toBeVisible();
  for (let step = 0; step < 10 && (await wanted.getAttribute('aria-selected')) !== 'true'; step++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(wanted).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const change = page.getByRole('button', { name: 'Change the test, now Haemoglobin' });
  await expect(change).toBeFocused();
  expect(await focusVisible(page)).toBe(true);

  await page.keyboard.press('Tab');
  await expect(orders.getByRole('combobox', { name: /^Priority/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(orders.getByRole('textbox', { name: /^Instructions/ })).toBeFocused();
  await page.keyboard.type('Before the transfusion');
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: 'Order the test' });
  await expect(submit).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Test ordered.')).toBeVisible();
  await expect(orders.getByText('Before the transfusion')).toBeVisible();

  // Cancelling asks why in place; focus goes to its heading, then to what was done.
  const cancel = orders.getByRole('button', { name: /^Cancel order: Complete blood count/ });
  await reach(cancel);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Cancel the order for Complete blood count' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: /^Why it is cancelled/ })).toBeFocused();
  await page.keyboard.type('Wrong test');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Order cancelled.')).toBeVisible();
  await expect(orders.getByText('Cancelled: Wrong test')).toBeVisible();
  // Focus is never left on the page body.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await focusVisible(page)).toBe(true);
  await expectNoAxeViolations(page);
});

test('order an imaging study with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  const imaging = page
    .getByRole('heading', { name: 'Imaging orders' })
    .locator('xpath=ancestor::section[1]');
  await expect(imaging.getByText('Chest X-ray')).toBeVisible();

  // The study is searched among the imaging services and chosen with the arrows and Enter.
  const search = imaging.getByRole('combobox', { name: 'Study' });
  await search.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('ultrasound');
  const wanted = page.getByRole('option', { name: 'Abdominal ultrasound (IMG-002)' });
  await expect(wanted).toBeVisible();
  await expect(wanted).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(
    imaging.getByRole('button', { name: 'Change the study, now Abdominal ultrasound' }),
  ).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(imaging.getByRole('combobox', { name: /^Priority/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(imaging.getByRole('textbox', { name: /^Instructions/ })).toBeFocused();
  await page.keyboard.type('Right iliac fossa pain');
  await page.keyboard.press('Tab');
  await expect(imaging.getByRole('button', { name: 'Order the study' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Enter');
  await expect(imaging.getByText('Imaging ordered.')).toBeVisible();
  await expect(imaging.getByText('Right iliac fossa pain')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await expectNoAxeViolations(page);
});

test('open a visit from the patient’s clinical timeline with the keyboard alone', async ({
  page,
}) => {
  await page.goto('/patients/pth_00001?tab=timeline');
  const tab = page.getByRole('tab', { name: 'Clinical timeline', selected: true });
  await expect(tab).toBeVisible();
  await expect(page.getByText('1 visit', { exact: true })).toBeVisible();
  await tab.focus();
  // The panel, then the filters, each with focus visible.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel', { name: 'Clinical timeline' })).toBeFocused();
  const type = page.getByRole('combobox', { name: 'Type of visit' });
  await page.keyboard.press('Tab');
  await expect(type).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await type.selectOption('ipd');
  await expect(page.getByText('No visits to show.')).toBeVisible();
  await type.selectOption('');
  await expect(page.getByText('1 visit', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // On to the visit's link, which opens the consultation.
  const visit = page.getByRole('tabpanel', { name: 'Clinical timeline' }).getByRole('link');
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press('Tab');
    if (await visit.evaluate((link) => link === document.activeElement)) break;
  }
  await expect(visit).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Consultation', exact: true })).toBeVisible();
});
