import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, goTo } from './support';

/**
 * The normal ranges for vital signs in a real browser, against the mock backend (#378, #379). A
 * hospital-wide setting, so a desktop-only screen (CLAUDE.md, Responsive Design): at desktop width
 * the journey of changing a limit with the keyboard, and below that the notice.
 *
 * A full page load resets the mock, so everything after the first load happens inside the app.
 */

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 1280) >= 1024;

test('change a limit of one age band with the keyboard, and save', async ({ page }) => {
  test.skip(!isDesktop(page), 'The ranges are a desktop-only screen.');
  await page.goto('/');
  await goTo(page, 'Triage');
  await expect(heading(page, 'Normal ranges for vital signs')).toBeVisible();
  await expectNoSidewaysScroll(page);

  const adult = page.getByRole('group', { name: 'Adult (18 years and over)' });
  const pulse = adult.getByRole('group', { name: /^Pulse/ });
  const high = pulse.getByRole('textbox', { name: 'High: above' });
  await expect(high).toHaveValue('100');
  await high.fill('110');
  await expect(high).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('status').filter({ hasText: /^Ranges saved/ })).toBeVisible();
  await expect(high).toHaveValue('110');
});

test('below desktop width the ranges say they need a wider display', async ({ page }) => {
  test.skip(isDesktop(page), 'At desktop width the screen itself is shown.');
  await page.goto('/');
  await goTo(page, 'Triage');

  await expect(heading(page, 'This screen needs a wider display')).toBeVisible();
  await expect(heading(page, 'Normal ranges for vital signs')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
