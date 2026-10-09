import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The shared building blocks in a real browser, on their example pages. These cover what the unit
 * tests cannot: real layout (charts draw, long grids virtualise and scroll), a real editing
 * surface, colour contrast, and which code is downloaded when.
 */

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
}

/** Script files requested so far, by the name of the chunk. */
function trackScripts(page: Page) {
  const loaded: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') loaded.push(request.url().split('/').pop() ?? '');
  });
  return (name: string) => loaded.some((file) => file.startsWith(`${name}-`));
}

test('heavy libraries are downloaded only on the pages that use them', async ({ page }) => {
  const loaded = trackScripts(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hospital management system' })).toBeVisible();
  expect(loaded('charts')).toBe(false);
  expect(loaded('editor')).toBe(false);

  // The index of the examples and the form page need neither.
  await page.goto('/examples/form');
  await expect(page.getByRole('heading', { name: 'Form kit', level: 1 })).toBeVisible();
  expect(loaded('charts')).toBe(false);
  expect(loaded('editor')).toBe(false);

  await page.goto('/examples/charts');
  await expect(page.locator('figure svg').first()).toBeVisible();
  expect(loaded('charts')).toBe(true);
  expect(loaded('editor')).toBe(false);

  await page.goto('/examples/editor');
  await expect(page.getByRole('textbox', { name: 'Example note' })).toBeVisible();
  expect(loaded('editor')).toBe(true);
});

test('data grid: sorts on the server, pages, and virtualises a long list', async ({ page }) => {
  await page.goto('/examples/grid');
  const table = page.getByRole('table', { name: 'Example people' });
  const dataRows = table.locator('tbody tr:not([aria-hidden])');
  await expect(dataRows).toHaveCount(50);
  await expectNoAxeViolations(page);

  // Sensitive columns are masked.
  await expect(table).not.toContainText('MRN-EX');

  await table.getByRole('columnheader', { name: 'Name' }).getByRole('button').click();
  await expect(table.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(dataRows.first()).toContainText('Asha');

  // Three pages make 150 rows: past the point where only the rows in view are rendered.
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('status')).toContainText('100 rows loaded');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('status')).toContainText('150 rows loaded');
  await expect(table).toHaveAttribute('aria-rowcount', '151');
  expect(await dataRows.count()).toBeLessThan(80);

  // Scrolling brings later rows into the DOM and drops the first ones.
  const scroller = table.locator('xpath=..');
  await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(table.locator('tr[aria-rowindex="151"]')).toBeVisible();
  await expect(table.locator('tr[aria-rowindex="2"]')).toHaveCount(0);
});

test('charts draw with the hospital colour and pass axe', async ({ page }) => {
  await page.goto('/examples/charts');
  const line = page.locator('figure svg path.recharts-line-curve').first();
  await expect(line).toBeVisible();
  // The series colour is the theme token, which the sample hospital sets to its brand colour.
  expect(await line.getAttribute('stroke')).toBe('var(--primary)');
  await expect(page.locator('figure svg .recharts-bar-rectangle').first()).toBeVisible();
  // The same numbers are available as a table to assistive technology.
  await expect(page.getByRole('table', { name: 'Visits by department' })).toContainText('505');
  await expectNoAxeViolations(page);
});

test('form kit: validates, announces errors, and submits from the keyboard', async ({ page }) => {
  await page.goto('/examples/form');
  await page.getByLabel('Full name').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').first()).toHaveText('This field is required.');
  await expectNoAxeViolations(page);

  await page.getByLabel('Full name').fill('Test Person');
  await page.getByLabel('Email').fill('person@example.test');
  await page.getByLabel('Department').selectOption('neurology');
  await page.getByLabel('Consent recorded').check();
  await page.getByLabel('Notes').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('region', { name: 'Submitted values' })).toContainText(
    '"department": "neurology"',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rich text: typing and formatting update the document, and pasted HTML is not trusted', async ({
  page,
}) => {
  await page.goto('/examples/editor');
  const editor = page.getByRole('textbox', { name: 'Example note' });
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(editor).toBeVisible();
  await expectNoAxeViolations(page);

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  // The toolbar hands focus back to the text on the next frame. Type once it is there.
  await expect(editor).toBeFocused();
  await page.keyboard.type('Review in two weeks');
  await expect(preview.locator('strong', { hasText: 'Review in two weeks' })).toBeVisible();

  // Paste markup that carries a script, an event handler, an image and a javascript: link.
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<p>pasted <a href="javascript:alert(1)">link</a><img src="x" onerror="window.__pwned = true">' +
        '<script>window.__pwned = true</script><span style="position:fixed" onclick="x()">styled</span></p>',
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(preview).toContainText('pasted');
  // Only the text survived, in the editor and in the preview.
  for (const surface of [editor, preview]) {
    await expect(surface.locator('a, img, script, [style], [onclick], [onerror]')).toHaveCount(0);
  }
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
});
