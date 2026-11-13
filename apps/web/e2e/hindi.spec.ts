import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, gridIsStacked } from './support';

/**
 * Hindi (#767): longer text must still fit. A few main screens (a list as cards, a form, the
 * navigation) are opened in Hindi, and axe and the reflow check run on each at 320 and 360 px
 * wide, besides the width the project runs at. `&mockLanguage=hi` gives the signed-in mock
 * user Hindi as their own language.
 */
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'Sets its own sizes: run once.');

const ROUTES = ['patients', 'appointments', 'queue', 'patients/new'];

async function openInHindi(page: Page, route: string): Promise<void> {
  await page.goto(`/${route}?mockUser=user_admin&mockLanguage=hi`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('main [data-loading]')).toHaveCount(0);
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

for (const width of [320, 360]) {
  for (const route of ROUTES) {
    test(`${route} in Hindi at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await openInHindi(page, route);
      expect(gridIsStacked(page)).toBe(true);
      await expectNoSidewaysScroll(page);
      await expectNoAxeViolations(page);
    });
  }
}

test('the Devanagari font loads only for Hindi', async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('devanagari')) fonts.push(request.url());
  });
  await page.goto('/patients');
  await expect(page.locator('main h1').first()).toBeVisible();
  expect(fonts).toEqual([]);
  await openInHindi(page, 'patients');
  await expect.poll(() => fonts.length).toBeGreaterThan(0);
});
