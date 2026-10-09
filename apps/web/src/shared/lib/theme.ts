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

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** WCAG AA for normal-size text. */
const MIN_TEXT_CONTRAST = 4.5;
const WHITE = '#ffffff';
const BLACK = '#000000';

/** WCAG relative luminance of a six-digit hex colour, or undefined if it is not one. */
function luminance(hex: string): number | undefined {
  const match = HEX_COLOR.exec(hex);
  if (!match) return undefined;
  const [r, g, b] = match.slice(1).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two six-digit hex colours (1 to 21), or undefined if invalid. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Turns a hospital's brand colour into theme tokens, or returns null when it must not be used.
 *
 * The primary colour is used both as a background (buttons) and as text on the page background
 * (links, the active hospital). So it is accepted only if it reads as text on white, and the
 * colour placed on top of it is black or white, whichever contrasts more. A hospital can
 * therefore never end up with a theme its staff cannot read.
 */
export function themeFromBrandColor(primary: string): ThemeOverrides | null {
  const onWhite = contrastRatio(primary, WHITE);
  const onBlack = contrastRatio(primary, BLACK);
  if (onWhite === undefined || onBlack === undefined) return null;
  if (onWhite < MIN_TEXT_CONTRAST) return null;
  return {
    primary,
    ring: primary,
    'primary-foreground': onWhite >= onBlack ? WHITE : BLACK,
  };
}

/** Remove tenant overrides (used on logout and tenant switch). */
export function resetTheme(root: HTMLElement = document.documentElement) {
  for (const token of THEME_TOKENS) root.style.removeProperty(`--${token}`);
}
