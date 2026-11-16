import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';

/**
 * The registered routes and how to open each on a record, shared by the specs that walk every
 * route (a11y.spec.ts, hindi.spec.ts).
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

export const routes = await registeredRoutes();

export function scheduledAppointment(page: Page): Promise<string> {
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
  // A role's permission matrix is opened from a row action of the role list, not a link.
  roles: () => Promise.resolve('doctor'),
  // Triage has no list of its own: a patient of the mock with readings and allergies.
  triage: () => Promise.resolve('pth_00001'),
  // The nursing chart (#157) is opened from a worklist row action: a patient of the mock is
  // admitted without a bed, under the first doctor.
  nursing: (page) =>
    page.evaluate(async () => {
      const doctors = (await (await fetch('/api/doctors?limit=1')).json()) as {
        items: { id: string }[];
      };
      const answer = await fetch('/api/admissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          patientId: 'pth_00001',
          admissionType: 'planned',
          doctorId: doctors.items[0]?.id,
        }),
      });
      return ((await answer.json()) as { id?: string }).id ?? '';
    }),
  // The discharge summary of a stay (#165): the same admission as the nursing chart's.
  admissions: async (page) => {
    const admit = RECORDS.nursing;
    return admit ? admit(page) : '';
  },
  // The running bill of a stay (#166) is opened from the admissions list's row action: the same
  // admission as the nursing chart's.
  'billing/stays': async (page) => {
    const admit = RECORDS.nursing;
    return admit ? admit(page) : '';
  },
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
  // A register session (#118) is opened from the day-end list, which starts empty: one drawer
  // is opened first.
  'billing/register/sessions': (page) =>
    page.evaluate(async () => {
      const answer = await fetch('/api/cash-registers/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ openingMinor: 10000 }),
      });
      return ((await answer.json()) as { id: string }).id;
    }),
  // The pharmacy's prescriptions are opened from a queue row action (#100): the mock's one.
  'pharmacy/prescriptions': () => Promise.resolve('rx_h_1'),
  // The mock keeps no counter sale until one is made (#101): two units of cetirizine.
  'pharmacy/sales': (page) =>
    page.evaluate(async () => {
      const answer = await fetch('/api/pharmacy/sales', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          locationId: 'loc_h_pharmacy',
          lines: [{ drugId: 'drg_h_0805', batches: [{ batchId: 'bat_h_rx5', quantity: 2 }] }],
        }),
      });
      return ((await answer.json()) as { id?: string }).id ?? '';
    }),
  // Purchase orders are opened from a list row action (#103): the mock's draft, which its edit
  // screen can also open.
  'purchasing/orders': () => Promise.resolve('po_h_draft'),
  // Indents are opened from a list row action (#105): the mock's approved one, which offers Issue.
  'inventory/indents': () => Promise.resolve('ind_h_approved'),
  // The mock keeps no goods receipt until one is made: a batch of the approved order.
  'purchasing/receipts': (page) =>
    page.evaluate(async () => {
      const answer = await fetch('/api/purchasing/orders/po_h_approved/receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          lines: [
            {
              orderLineId: 'po_h_approved_line_1',
              batchNumber: 'A11Y-1',
              expiryDate: '2030-06-30',
              quantity: 10,
              unitCostMinor: 2800,
            },
          ],
        }),
      });
      return ((await answer.json()) as { id?: string }).id ?? '';
    }),
  // The mock keeps no invoice until one is made (#109): a draft of the open consultation's
  // consultation fee.
  'billing/invoices': (page) =>
    page.evaluate(async () => {
      const answer = await fetch('/api/encounters/enc_h_1/invoices', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ chargeIds: ['chg_h_1'], manualLines: [] }),
      });
      return ((await answer.json()) as { id?: string }).id ?? '';
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
export async function open(page: Page, route: string, query = ''): Promise<void> {
  const segments = route.split('/');
  const at = segments.findIndex((segment) => segment.startsWith(':'));
  if (segments.filter((segment) => segment.startsWith(':')).length > 1) {
    throw new Error(`${route} has more than one id: teach open() how to fill them`);
  }
  if (at === -1) {
    await page.goto(`/${route}${query}`);
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
  await page.goto(`/${list}${query}`);
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
export async function navigate(page: Page, address: string): Promise<void> {
  const before = await page.locator('main h1').first().elementHandle();
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, address);
  await expect(page).toHaveURL(address);
  await before?.waitForElementState('hidden');
}

export const desktopOnlyNotice = (page: Page) =>
  page.getByRole('heading', {
    name: /This screen needs a wider display|इस स्क्रीन के लिए बड़ा डिस्प्ले चाहिए/,
  });

/** Waits for the screen to settle: its heading is shown and nothing is loading any more. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('main [data-loading]')).toHaveCount(0);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('main h1').first()).not.toHaveText('');
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}
