import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * The OPD queue in a real browser against the mock backend, at every supported width: a token
 * issued at the desk with the keyboard alone, then called, skipped and put back in the queue from
 * the board, also with the keyboard alone, with focus never left on the page. Live updates
 * between two screens are checked in the unit tests (`features/queue/queue.test.tsx`): each page
 * here has its own mock, so two pages cannot share a queue.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

/** The focused element, as its tag and accessible text, to check where focus went. */
const focusedText = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName.toLowerCase()}:${element.textContent?.trim() ?? ''}` : '';
  });

test('issue a token to a walk-in with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'OPD queue');
  await expect(page.getByRole('heading', { name: 'OPD queue', exact: true })).toBeVisible();
  await expect(page.getByText('Live: changes show within seconds.')).toBeVisible();
  await page.getByRole('link', { name: 'Issue a token' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Issue a token' })).toBeVisible();

  // Sent empty: focus goes to the first field to fix, the patient, with its message.
  await page.getByRole('button', { name: 'Issue token' }).focus();
  await page.keyboard.press('Enter');
  const patient = page.getByRole('combobox', { name: 'Patient' });
  await expect(patient).toBeFocused();
  await expect(patient).toHaveAccessibleDescription('Choose the patient.');
  await page.keyboard.type('MRN-PTH-00001');
  await expect(page.getByRole('option', { name: /MRN-PTH-00001/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Choose another patient' })).toBeFocused();

  await page.getByRole('combobox', { name: /^Department/ }).selectOption('dep_h_02');
  await page.getByRole('combobox', { name: /^Priority/ }).selectOption('senior_citizen');
  await page.getByRole('button', { name: 'Issue token' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Token 3 issued' })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // On the board, after the earlier tokens with a priority and ahead of those with none. Every
  // department numbers its own tokens, so the row is told by its patient.
  await page.getByRole('link', { name: 'Back to the queue' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'OPD queue', exact: true })).toBeVisible();
  const priorities = page
    .getByRole('region', { name: 'Waiting' })
    .getByRole('button', { name: /^Change priority: / });
  await expect(priorities.nth(2)).toHaveAccessibleName('Change priority: Token 3, Asha Verma1');
});

test('call, skip and put back a patient from the board with the keyboard alone', async ({
  page,
}) => {
  await page.goto('/');
  await goTo(page, 'OPD queue');
  await expect(page.getByText('Live: changes show within seconds.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Doctor' }).selectOption('doc_h_01');
  const serving = page.getByRole('region', { name: 'Now serving' });
  const skipped = page.getByRole('region', { name: 'Skipped' });
  await expect(serving.getByText('Token 1', { exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // Call the next one: the senior citizen's token, ahead of the others.
  const callNext = page.getByRole('button', { name: /^Call next for / });
  await callNext.focus();
  await page.keyboard.press('Enter');
  const status = page.getByRole('status').filter({ hasText: /^Token \d+, .+\.$/ });
  await expect(status).toHaveText(/^Token 4, .+, called\.$/);
  await expect(serving.getByText('Token 4', { exact: true })).toBeVisible();
  await expect(callNext).toBeFocused();

  // The patient does not come: skipped. The row leaves the group, and focus goes to the line
  // that says what was done, never to the page.
  await serving.getByRole('button', { name: /^Skip/ }).focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/^Token 4, .+, skipped\.$/);
  await expect(skipped.getByText('Token 4', { exact: true })).toBeVisible();
  expect(await focusedText(page)).toMatch(/^p:Token 4, .+, skipped\.$/);

  // They come back: in the queue again, at their place.
  await skipped
    .getByRole('button', { name: /^Back in the queue/ })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/is back in the queue\.$/);
  await expect(
    page.getByRole('region', { name: 'Waiting' }).getByText('Token 4', { exact: true }),
  ).toBeVisible();
  expect(await focusedText(page)).not.toBe('body:');
  await expectNoAxeViolations(page);
});

test('change a token’s priority in its panel, and come back to where it started', async ({
  page,
}) => {
  await page.goto('/');
  await goTo(page, 'OPD queue');
  const waiting = page.getByRole('region', { name: 'Waiting' });
  const open = waiting.getByRole('button', { name: /^Change priority/ }).nth(2);
  await open.focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: /^Priority of token/ });
  await expect(heading).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(heading).toBeHidden();
  await expect(open).toBeFocused();
});

test('check in a booked patient from today’s appointments with the keyboard alone', async ({
  page,
}) => {
  await page.goto('/');
  await goTo(page, 'Appointments');
  await expect(page.getByRole('heading', { name: 'Appointments', exact: true })).toBeVisible();
  const checkIn = page.getByRole('button', { name: /^Check in, appointment at / }).first();
  await checkIn.focus();
  await page.keyboard.press('Enter');

  // The button gives way to what was done, and focus follows it there.
  const done = page.getByRole('status').filter({ hasText: /^Checked in: token \d+, .+\.$/ });
  await expect(done).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);
});
