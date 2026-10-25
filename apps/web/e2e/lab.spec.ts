import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The laboratory worklist (#90) in a real browser against the mock backend, at every supported
 * width: a sample collected, its label printed and the sample received, with the keyboard alone
 * and focus visible at each step.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const focusVisible = (page: Page) =>
  page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

/** Reached by Tab, as the keyboard would arrive at it. */
async function reach(page: Page, target: ReturnType<Page['getByRole']>) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

test('collect a sample, print its label and receive it with the keyboard alone', async ({
  page,
}) => {
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
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  await expectNoSidewaysScroll(page);

  const collect = page.getByRole('button', { name: /^Collect sample: .+, Complete blood count$/ });
  await reach(page, collect);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Collect sample: Complete blood count' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(panel.getByText('Date of birth')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Mark as collected' })).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText(/^Collected as \d{6}-\d{4}\./);
  const accession = ((await panel.getByRole('status').textContent()) ?? '').match(
    /\d{6}-\d{4}/,
  )?.[0];

  // The button pressed becomes Print label, and keeps focus.
  const print = panel.getByRole('button', { name: 'Print label' });
  await expect(print).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(printed).toBe(1);
  await expect(page.locator('[data-print-sheet]')).toHaveCount(0);
  await expect(print).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);

  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('collected');
  const receive = page.getByRole('button', { name: /^Receive: .+, Complete blood count$/ });
  await reach(page, receive);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Sample ${accession} received.`, { exact: false })).toBeFocused();
  await expectNoAxeViolations(page);
});

test('send a sample to a partner laboratory and take its report back with the keyboard alone (#94)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  // The blood count collected and received, as the laboratory would before sending it out.
  await page.evaluate(async () => {
    const post = async (path: string, body?: unknown) => {
      const answer = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await answer.json()) as { id?: string };
    };
    const sample = await post('/lab/orders/ord_h_lab_1/samples');
    await post(`/lab/samples/${sample.id ?? ''}/receive`, { version: 1 });
  });

  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('received');
  const sendOut = page.getByRole('button', {
    name: /^Send to partner lab: .+, Complete blood count$/,
  });
  await reach(page, sendOut);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: /^Send sample .+ to a partner laboratory$/ });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.keyboard.press('Tab');
  await expect(panel.getByLabel(/Partner laboratory/)).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('City Lab');
  await page.keyboard.press('Tab');
  await expect(panel.getByLabel(/Partner’s reference/)).toBeFocused();
  await page.keyboard.type('CL-12');
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Mark as sent' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Sample .+ sent to City Lab\./)).toBeFocused();

  await reach(page, stage);
  await stage.selectOption('with_partner');
  const reportBack = page.getByRole('button', {
    name: /^Report received: .+, Complete blood count$/,
  });
  await reach(page, reportBack);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Partner report for sample .+ received/)).toBeFocused();
  await expectNoAxeViolations(page);
});

test('enter a result and verify it with the keyboard alone (#91)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  // The haemoglobin's sample collected and received, from inside the app once the mock answers.
  await page.evaluate(async () => {
    const post = async (path: string, body?: unknown) => {
      const answer = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await answer.json()) as { id?: string };
    };
    const sample = await post('/lab/orders/ord_h_lab_2/samples');
    await post(`/lab/samples/${sample.id ?? ''}/receive`, { version: 1 });
  });
  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('received');
  const results = page.getByRole('button', { name: /^Results: .+, Haemoglobin$/ });
  await reach(page, results);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Results: Haemoglobin', level: 1 })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const value = page.getByRole('textbox', { name: 'Haemoglobin (g/dL)' });
  await reach(page, value);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.type('6.5');
  const save = page.getByRole('button', { name: 'Save results' });
  await reach(page, save);
  await page.keyboard.press('Enter');
  const status = page.getByRole('status').filter({ hasText: /result saved/ });
  await expect(status).toHaveText(/Critical: Haemoglobin/);
  await expect(status).toBeFocused();

  const tick = page.getByRole('checkbox', { name: /^Haemoglobin: 6.5 g\/dL, Critical low/ });
  await reach(page, tick);
  await expect(tick).toBeChecked();
  expect(await focusVisible(page)).toBe(true);
  const verify = page.getByRole('button', { name: 'Verify ticked results' });
  await reach(page, verify);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /verified/ })).toBeFocused();
  await expect(page.getByText(/the order is completed/)).toBeVisible();
  await expectNoAxeViolations(page);
});

test('print a report, acknowledge a critical result and open a trend with the keyboard alone (#92)', async ({
  page,
}) => {
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  // The blood count of Asha Verma1 collected, resulted (a critical haemoglobin) and verified, as
  // the laboratory would, from inside the app once the mock answers.
  await page.evaluate(async () => {
    const post = async (path: string, body?: unknown) => {
      const answer = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await answer.json()) as { id?: string; results?: { id: string }[] };
    };
    const sample = await post('/lab/orders/ord_h_lab_1/samples');
    await post(`/lab/samples/${sample.id ?? ''}/receive`, { version: 1 });
    const values = { hb: '6.5', wbc: '7', plt: '250', rbc: '5', hct: '40', mcv: '90' };
    const entered = await post(`/lab/samples/${sample.id ?? ''}/results`, {
      results: Object.entries(values).map(([code, value]) => ({
        labTestId: `lab_h_${code}`,
        value,
      })),
    });
    await post(`/lab/samples/${sample.id ?? ''}/verify`, {
      resultIds: (entered.results ?? []).map((result) => result.id),
    });
  });
  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('completed');
  const results = page.getByRole('button', { name: /^Results: .+, Complete blood count$/ });
  await reach(page, results);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Results: Complete blood count', level: 1 }),
  ).toBeVisible();

  // The report: recorded, then printed.
  const print = page.getByRole('button', { name: 'Print report' });
  await reach(page, print);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(printed).toBe(1);
  await expect(page.locator('[data-print-sheet]')).toHaveCount(0);

  // The critical haemoglobin, acknowledged.
  await expect(page.getByText('Critical, not acknowledged')).toBeVisible();
  const acknowledge = page.getByRole('button', { name: /^Acknowledge/ }).first();
  await reach(page, acknowledge);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Critical result of Haemoglobin acknowledged.')).toBeVisible();
  await expect(page.getByText(/^Acknowledged by /)).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The patient's lab results, and a test's trend.
  await goTo(page, 'Patients');
  await page.getByRole('link', { name: 'Asha Verma1', exact: true }).click();
  // The tabs are one stop: the arrow keys move along them from the one selected.
  const tab = page.getByRole('tab', { name: 'Lab results' });
  await page.getByRole('tab', { selected: true }).focus();
  for (let step = 0; step < 10; step++) {
    if (await tab.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(tab).toBeFocused();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('6.5 g/dL')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
  const trend = page.getByRole('button', { name: /^Show trend/ }).first();
  await reach(page, trend);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /^Trend of / })).toBeFocused();
  const close = page.getByRole('button', { name: 'Close trend' });
  await reach(page, close);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /^Trend of / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show trend/ }).first()).toBeFocused();
});

test('a lab test from the doctor’s order to its result in the consultation (#93)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  // The doctor orders a haemoglobin for the patient of the consultation.
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  const orders = page
    .getByRole('heading', { name: 'Lab orders' })
    .locator('xpath=ancestor::section[1]');
  await orders.getByRole('combobox', { name: 'Test or panel' }).fill('haemoglobin');
  await page.getByRole('option', { name: 'Haemoglobin (HB), Single test' }).click();
  await orders.getByRole('button', { name: 'Order the test' }).click();
  await expect(page.getByText('Test ordered.')).toBeVisible();
  const patient = 'Asha Verma1';

  // The sample is collected and received on the worklist.
  await goTo(page, 'Laboratory');
  await expect(page.getByRole('heading', { name: 'Laboratory worklist' })).toBeVisible();
  await page.getByRole('button', { name: `Collect sample: ${patient}, Haemoglobin` }).click();
  const panel = page.getByRole('region', { name: 'Collect sample: Haemoglobin' });
  await panel.getByRole('button', { name: 'Mark as collected' }).click();
  await expect(panel.getByRole('status')).toHaveText(/^Collected as \d{6}-\d{4}\./);
  await panel.getByRole('button', { name: 'Close' }).click();
  const stage = page.getByRole('combobox', { name: 'Stage' });
  await stage.selectOption('collected');
  await page.getByRole('button', { name: `Receive: ${patient}, Haemoglobin` }).click();
  await expect(page.getByText(/^Sample \d{6}-\d{4} received\./)).toBeVisible();

  // The result is entered, then verified, which completes the order.
  await stage.selectOption('received');
  await page.getByRole('button', { name: `Results: ${patient}, Haemoglobin` }).click();
  await expect(page.getByRole('heading', { name: 'Results: Haemoglobin', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Haemoglobin (g/dL)' }).fill('6.5');
  await page.getByRole('button', { name: 'Save results' }).click();
  await expect(page.getByRole('status').filter({ hasText: /result saved/ })).toHaveText(
    /Critical: Haemoglobin/,
  );
  await expect(
    page.getByRole('checkbox', { name: /^Haemoglobin: 6.5 g\/dL, Critical low/ }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Verify ticked results' }).click();
  await expect(page.getByText(/the order is completed/)).toBeVisible();
  await expectNoSidewaysScroll(page);

  // The doctor sees the verified result, and its flag in words, in the consultation.
  await goTo(page, 'Consultations');
  await page.getByRole('main').getByRole('link').first().click();
  const released = page
    .getByRole('heading', { name: 'Lab results of this visit' })
    .locator('xpath=ancestor::section[1]');
  await expect(released.getByText('6.5 g/dL')).toBeVisible();
  await expect(released.getByText('Critical low')).toBeVisible();
  await expect(released.getByText('Critical, not acknowledged')).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});
