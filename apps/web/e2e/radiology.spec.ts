import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, goTo } from './support';

/**
 * Radiology's worklist (#96) in a real browser against the mock backend, at every supported
 * width: a study scheduled, then performed, with the keyboard alone and focus visible at each
 * step.
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

test('schedule a study and mark it performed with the keyboard alone', async ({ page }) => {
  // Colour transitions are instant, so axe never samples a button halfway to its pressed colour.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await goTo(page, 'Radiology');
  await expect(page.getByRole('heading', { name: 'Radiology worklist' })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  const schedule = page.getByRole('button', { name: /^Schedule: .+, Chest X-ray$/ });
  await reach(page, schedule);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Schedule Chest X-ray' });
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await expectNoAxeViolations(page);

  // The day and the next slot are filled in: Tab to the start time, then to the button.
  const time = panel.getByRole('combobox', { name: /^Start time/ });
  await reach(page, time);
  expect(await focusVisible(page)).toBe(true);
  const submit = panel.getByRole('button', { name: 'Schedule study' });
  await reach(page, submit);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  const status = page.getByRole('status').filter({ hasText: 'scheduled for' });
  await expect(status).toBeFocused();

  const stage = page.getByRole('combobox', { name: 'Stage' });
  await reach(page, stage);
  await stage.selectOption('scheduled');
  const perform = page.getByRole('button', { name: /^Mark as performed: .+, Chest X-ray$/ });
  await reach(page, perform);
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  // The row leaves the stage, so focus goes to the status line that says what was done.
  await expect(page.getByRole('status').filter({ hasText: 'marked as performed' })).toBeFocused();
  await expect(page.getByText('No studies are scheduled.')).toBeVisible();
  await expectNoAxeViolations(page);
});
