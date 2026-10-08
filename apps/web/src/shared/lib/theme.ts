/**
 * Runtime theming. Tenant config supplies branding tokens after login; applyTheme writes them
 * to CSS variables on the document root so every component re-themes without a rebuild.
 * Only known token names are accepted, so tenant data can never inject arbitrary CSS properties.
 */
export const THEME_TOKENS = [
  'radius',
  'primary',
  'primary-foreground',
  'ring',
  'accent',
  'accent-foreground',
  'background',
  'foreground',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeOverrides = Partial<Record<ThemeToken, string>>;

const SAFE_VALUE = /^[\w\s.,%#()/-]+$/;

export function applyTheme(
  overrides: ThemeOverrides,
  root: HTMLElement = document.documentElement,
) {
  for (const token of THEME_TOKENS) {
    const value = overrides[token];
    if (value === undefined) continue;
    if (!SAFE_VALUE.test(value)) continue;
    root.style.setProperty(`--${token}`, value);
  }
}

/** Remove tenant overrides (used on logout and tenant switch). */
export function resetTheme(root: HTMLElement = document.documentElement) {
  for (const token of THEME_TOKENS) root.style.removeProperty(`--${token}`);
}
