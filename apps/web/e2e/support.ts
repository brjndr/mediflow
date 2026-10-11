import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers shared by the specs, which all run at three widths (see playwright.config.ts): a
 * desktop, a tablet and a phone. What differs between them is how the navigation is reached and
 * whether a data grid is a table or a list of cards.
 */

export const sidebar = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Main navigation' });

/**
 * Whether this run's screen is narrow enough for a full-width data grid to show cards. The grid
 * decides from its own container, which is the viewport less the page's padding, so this is the
 * phone project and not the tablet one. A spec that needs to be certain reads the page instead:
 * a grid is a `list` with its label when it shows cards and a `table` when it does not.
 */
export const gridIsStacked = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 640;

/**
 * The navigation, wherever this width keeps it: the sidebar on a desktop, the drawer behind the
 * menu button on a tablet or a phone. Opens the drawer if that is where it is.
 */
export async function openNavigation(page: Page): Promise<Locator> {
  const menuButton = page.getByRole('button', { name: 'Open menu' });
  // One of the two is on screen once the shell has rendered.
  await expect(sidebar(page).or(menuButton).first()).toBeVisible();
  if (!(await menuButton.isVisible())) return sidebar(page);
  await menuButton.click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer).toBeVisible();
  return drawer.getByRole('navigation', { name: 'Main navigation' });
}

/** Follows a link in the main navigation, as a person would at this width. */
export async function goTo(page: Page, name: string): Promise<void> {
  const navigation = await openNavigation(page);
  await navigation.getByRole('link', { name }).click();
}

/**
 * The page fits the screen: nothing makes the whole page scroll sideways. A wide table may
 * scroll inside its own box; the page itself may not.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  );
  expect(overflow, 'the page is wider than the screen').toBeLessThanOrEqual(0);
}
