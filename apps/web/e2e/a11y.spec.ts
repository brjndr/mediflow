import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoSidewaysScroll, gridIsStacked } from './support';

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

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The registered routes, read from `src/registry/features.ts` and each feature's `manifest.ts`.
 * The spec cannot import the registry as code (it belongs to the app's own TypeScript project),
 * but a manifest holds its routes as data and lazy imports, so loading one runs nothing of the
 * app. Reading the registration list keeps a feature that is written but not registered out.
 */
async function registeredRoutes(): Promise<string[]> {
  const source = readFileSync(path.join(webRoot, 'src/registry/features.ts'), 'utf8');
  const folders = new Map(
    [...source.matchAll(/import \{ (\w+) \} from '@\/features\/([\w-]+)';/g)].map(
      ([, name, folder]) => [name, folder] as const,
    ),
  );
  const list = /export const features: FeatureManifest\[\] = \[([^\]]*)\]/.exec(source)?.[1];
  if (!list) throw new Error('The features list was not found in src/registry/features.ts');
  const routes: string[] = [];
  for (const name of list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const folder = folders.get(name);
    if (!folder) throw new Error(`${name} is registered but not imported from a feature folder`);
    const file = path.join(webRoot, 'src/features', folder, 'manifest.ts');
    const manifest = ((await import(pathToFileURL(file).href)) as Record<string, unknown>)[name] as
      { routes: { path: string }[] } | undefined;
    if (!manifest) throw new Error(`${folder}/manifest.ts does not export ${name}`);
    routes.push(...manifest.routes.map((route) => route.path));
  }
  return routes;
}

const routes = await registeredRoutes();

/**
 * An appointment of the mock that is still to come, so every change of status is offered on it.
 * The days start from tomorrow in UTC, which is no earlier than today at any hospital east of
 * UTC (the mock's are), and run a week, inside the days the mock books.
 */
function scheduledAppointment(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const answer = await fetch(
      `/api/appointments?from=${day(1)}&to=${day(6)}&status=scheduled&limit=1`,
    );
    const { items } = (await answer.json()) as { items: { id: string }[] };
    return items[0]?.id ?? '';
  });
}

/**
 * How to find a record for a route with an id in its path, when the list above it has no link
 * to one: the record is fetched (or made) through the mock API from inside the page, and its id
 * returned. Any other id route is opened on the first record its list links to; a route with
 * neither fails, so add it here.
 */
const RECORDS: Partial<Record<string, (page: Page) => Promise<string>>> = {
  // A row opens the appointment from its row action, not a link.
  appointments: (page) => scheduledAppointment(page),
  // Triage has no list of its own: a patient of the mock with readings and allergies.
  triage: () => Promise.resolve('pth_00001'),
  // A lab order's results (#91) are opened from a worklist row action: its sample collected,
  // received and one result entered, so entry and verifying are both on the screen.
  'lab/orders': (page) =>
    page.evaluate(async () => {
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
      await post(`/lab/samples/${sample.id ?? ''}/results`, {
        results: [{ labTestId: 'lab_h_hb', value: '13.5' }],
      });
      return 'ord_h_lab_1';
    }),
  // The mock keeps no import until one is started.
  imports: (page) =>
    page.evaluate(async () => {
      const answer = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'services' }),
      });
      return ((await answer.json()) as { id?: string }).id ?? '';
    }),
};

/**
 * Opens the route. One with an id in its path is opened on a record, from the list above it and
 * inside the app, as a link would: a full page load starts the mock afresh, which would lose a
 * record made through it a moment before.
 */
async function open(page: Page, route: string): Promise<void> {
  const segments = route.split('/');
  const at = segments.findIndex((segment) => segment.startsWith(':'));
  if (segments.filter((segment) => segment.startsWith(':')).length > 1) {
    throw new Error(`${route} has more than one id: teach open() how to fill them`);
  }
  if (at === -1) {
    await page.goto(`/${route}`);
    return;
  }
  const list = segments.slice(0, at).join('/');
  // Another route at the same place (`new`, `calendar`) is not a record.
  const siblings = new Set(
    routes
      .map((other) => other.split('/'))
      .filter((other) => other.length > at && other.slice(0, at).join('/') === list)
      .map((other) => other[at]),
  );
  await page.goto(`/${list}`);
  await settled(page);
  const find = RECORDS[list];
  let id: string;
  if (await desktopOnlyNotice(page).isVisible()) {
    // Below desktop width the record's screen is the same notice, whatever the id.
    id = 'any';
  } else if (find) {
    id = await find(page);
  } else {
    const hrefs = await page
      .locator(`main a[href^="/${list}/"]`)
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    id =
      hrefs
        .map((href) => href.slice(list.length + 2).split(/[/?#]/)[0])
        .find((candidate) => candidate && !siblings.has(candidate)) ?? '';
  }
  expect(id, `no record to open ${route} with: add a way to find one to RECORDS`).not.toBe('');
  segments[at] = id;
  await navigate(page, `/${segments.join('/')}`);
}

/**
 * Goes to an address inside the app, as a link would, and waits for the screen that was there
 * to go: until then its heading would pass for the new screen's.
 */
async function navigate(page: Page, address: string): Promise<void> {
  const before = await page.locator('main h1').first().elementHandle();
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, address);
  await expect(page).toHaveURL(address);
  await before?.waitForElementState('hidden');
}

const desktopOnlyNotice = (page: Page) =>
  page.getByRole('heading', { name: 'This screen needs a wider display' });

/** Waits for the screen to settle: its heading is shown and nothing is loading any more. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('main [data-loading]')).toHaveCount(0);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

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
