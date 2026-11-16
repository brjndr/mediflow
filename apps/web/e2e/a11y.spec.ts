import { expect, test } from '@playwright/test';
import {
  expectModalHidesLandmarks,
  expectNoAxeViolations,
  expectNoSidewaysScroll,
  gridIsStacked,
  goTo,
} from './support';
import { desktopOnlyNotice, navigate, open, routes, scheduledAppointment, settled } from './routes';

/**
 * axe on every route a feature registers, in a real browser with colour contrast checked
 * (WCAG 2.2 AA, see Accessibility in CLAUDE.md). The routes come from the registry itself, so a
 * route added to a feature is checked without editing this file.
 *
 * Each route is checked at desktop width and at phone width, where a list becomes cards and a
 * desktop-only screen becomes its notice. The tablet has the desktop's content in a narrower
 * window, so it is not checked again. A route that adds a record (`…/new`, `…/invite`) is also
 * checked with its form sent empty, showing its errors, when it opens on a form; a few other states (an empty list, an
 * open menu, an open form on a record) are listed below.
 */

/**
 * The theme switch keeps its choice in `localStorage` (`mediflow.theme`, shared/lib/color-scheme.ts)
 * and the page applies it before first paint. `A11Y_DARK=1 pnpm e2e a11y` saves "dark" first and
 * runs this whole file in dark, as the visual refresh check (#714) did. CI runs light only, to
 * keep the job's time.
 */
if (process.env.A11Y_DARK) {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('mediflow.theme', 'dark'));
  });
}

/**
 * An appointment of the mock that is still to come, so every change of status is offered on it.
 * The days start from tomorrow in UTC, which is no earlier than today at any hospital east of
 * UTC (the mock's are), and run a week, inside the days the mock books.
 */

/**
 * Rules switched off on one screen, until the issue named beside each fixes them. Keyed by route.
 */
const KNOWN: Record<string, string[]> = {};

/** The tablet's width (768 to 1023 px), between the phone and the desktop that are checked. */
const isTablet = ({ viewport }: { viewport: { width: number } | null }) =>
  viewport !== null && viewport.width >= 768 && viewport.width < 1024;

const addsARecord = (route: string) => /(^|\/)(new|invite)$/.test(route);

/** Routes that add a record but do not open on a form. */
const NO_FORM_AT_FIRST = new Set([
  // The import centre starts from choosing a file.
  'imports/new',
  // A new invoice opens on a visit's id in the address (the consultation's link); without one it
  // says the visit is not available. The builder's own form is checked in billing.spec.ts.
  'billing/new',
]);

test('the exceptions name routes that exist', () => {
  const stale = [...Object.keys(KNOWN), ...NO_FORM_AT_FIRST].filter(
    (route) => !routes.includes(route),
  );
  expect(stale, 'remove these: no such route is registered').toEqual([]);
});

test.describe('every feature route passes axe', () => {
  test.skip(isTablet, 'The tablet shows the desktop content: checked at desktop width.');

  for (const route of routes) {
    test(route, async ({ page }) => {
      await open(page, route);
      await settled(page);
      // Below desktop width a desktop-only screen is its notice. Anything else that stands in
      // for the screen (not found, no access, an error) means the route was not reached.
      const notice = await desktopOnlyNotice(page).isVisible();
      if (!notice) {
        await expect(page.locator('[data-system-page]'), `${route} was not reached`).toHaveCount(0);
      }
      await expectNoAxeViolations(page, { disable: KNOWN[route] });

      if (addsARecord(route) && !notice && !NO_FORM_AT_FIRST.has(route)) {
        const submit = page.locator('main form button[type="submit"]').first();
        await submit.click();
        await expect(page.locator('main [aria-invalid="true"]').first()).toBeVisible();
        await expectNoAxeViolations(page, { disable: KNOWN[route] });
      }
    });
  }
});

/**
 * A few routes in dark too, on every CI run (#762): the home page, a list, a form, a worklist and
 * the billing list. The whole file in dark is `A11Y_DARK=1`; this keeps a regression in the dark
 * tokens from waiting for someone to run that. Desktop only, to keep the job's time.
 */
test.describe('a few routes pass axe in dark', () => {
  test.skip(
    ({ viewport }) => viewport === null || viewport.width < 1024,
    'Checked once, at desktop.',
  );
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('mediflow.theme', 'dark'));
  });

  for (const route of ['', 'patients', 'patients/new', 'lab', 'billing/invoices']) {
    test(route || 'home', async ({ page }) => {
      await open(page, route);
      await settled(page);
      await expect(page.locator('[data-system-page]'), `${route} was not reached`).toHaveCount(0);
      await expectNoAxeViolations(page, { disable: KNOWN[route] });
    });
  }
});

test.describe('screens in other states pass axe', () => {
  test.skip(isTablet, 'The tablet shows the desktop content: checked at desktop width.');

  test('a list with nothing found', async ({ page }) => {
    await page.goto('/patients');
    await settled(page);
    await page
      .getByRole('searchbox', { name: 'Search patients' })
      .fill('zzzz-nobody-has-this-name');
    await expect(page.getByText('No patients match your search.')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('the columns menu of a list, open', async ({ page }) => {
    test.skip(gridIsStacked(page), 'Cards have no columns to choose.');
    await page.goto('/patients');
    await settled(page);
    await page.locator('main summary').filter({ hasText: 'Columns' }).click();
    await expect(page.locator('main details[open] fieldset')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('a modal leaves no live region exposed inside a landmark', async ({ page }) => {
    await page.goto('/');
    await goTo(page, 'Housekeeping');
    await settled(page);
    await page.getByRole('button', { name: 'Request a cleaning' }).click();
    await expectModalHidesLandmarks(page);
    await expectNoAxeViolations(page);
  });

  test('a form opened on a record, sent empty', async ({ page }) => {
    await page.goto('/appointments');
    await settled(page);
    await navigate(page, `/appointments/${await scheduledAppointment(page)}`);
    await settled(page);
    await page.getByRole('button', { name: 'Cancel the appointment' }).click();
    await page.locator('main form button[type="submit"]').first().click();
    await expect(page.locator('main [aria-invalid="true"]').first()).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

/**
 * A hospital's brand colour (#714): the landing page, its sidebar and its widgets, with the
 * tokens `applyTheme` writes for that colour, pass axe with contrast on.
 */
test.describe('a hospital brand colour passes axe', () => {
  test.skip(isTablet, 'The tablet shows the desktop content: checked at desktop width.');

  // What themeFromBrandColor makes of each colour (the e2e project cannot import app code); the
  // function itself, and the colour it refuses, are tested in tenancy/theming.test.tsx.
  for (const [label, colour, text, dark] of [
    ['a standard one', '#0f766e', '#ffffff', '#3f918b'],
    ['a very dark one', '#0b1020', '#ffffff', '#858890'],
    ['a low-chroma one', '#5b6470', '#ffffff', '#7c838d'],
    ['one that takes black text', '#757575', '#000000', '#838383'],
  ] as const) {
    test(label, async ({ page }) => {
      await page.goto('/');
      await settled(page);
      await page.evaluate(
        ({ primary, foreground, dark }) => {
          const root = document.documentElement.style;
          root.setProperty('--primary', primary);
          root.setProperty('--ring', primary);
          root.setProperty('--primary-foreground', foreground);
          root.setProperty('--primary-dark', dark);
          root.setProperty('--primary-dark-foreground', '#000000');
        },
        { primary: colour, foreground: text, dark },
      );
      await expectNoAxeViolations(page);
    });
  }
});

/** The desktop project only: these set their own window size, so one run is enough. */
const isDesktopProject = ({ viewport }: { viewport: { width: number } | null }) =>
  viewport !== null && viewport.width >= 1024;

test.describe('every feature route reflows at 320 px (400% zoom)', () => {
  test.skip(({ viewport }) => !isDesktopProject({ viewport }), 'Checked once, at its own size.');

  for (const route of routes) {
    test(route, async ({ page }) => {
      // A 1280 px window at 400% zoom: 320 CSS px wide (WCAG 1.4.10).
      await page.setViewportSize({ width: 320, height: 720 });
      await open(page, route);
      await settled(page);
      // Content reflows into one column; only a grid or the calendar scrolls, inside its box.
      // A desktop-only screen says so instead of breaking.
      await expectNoSidewaysScroll(page);
    });
  }
});

test.describe('every feature route takes text at 200%', () => {
  test.skip(({ viewport }) => !isDesktopProject({ viewport }), 'Checked once, at its own size.');

  for (const route of routes) {
    test(route, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      // Text-only zoom, as a browser's text size setting does: every size is in rem.
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.style.fontSize = '200%';
        });
      });
      await open(page, route);
      await settled(page);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
        'the text was not enlarged',
      ).toBe('32px');
      await expectNoSidewaysScroll(page);
    });
  }
});

test('nothing moves when the system asks for reduced motion', async ({ page }) => {
  /** How long an element that asks to move for a second actually takes. */
  const durations = () =>
    page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.animation = 'probe 1s infinite';
      probe.style.transition = 'opacity 1s';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = [parseFloat(style.animationDuration), parseFloat(style.transitionDuration)];
      probe.remove();
      return result;
    });
  await page.goto('/patients');
  await settled(page);
  expect(await durations()).toEqual([1, 1]);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const [animation, transition] = await durations();
  expect(animation).toBeLessThan(0.001);
  expect(transition).toBeLessThan(0.001);
});
