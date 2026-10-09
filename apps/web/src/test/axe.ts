import axe from 'axe-core';

/**
 * Runs the axe accessibility engine on the rendered document and fails on any violation.
 * Colour contrast is skipped here because jsdom does not compute styles; the Playwright smoke
 * test runs the same engine in a real browser with contrast checks on.
 */
export async function expectNoAxeViolations(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } });
  const violations = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.html).join(' | ')})`,
  );
  expect(violations).toEqual([]);
}
