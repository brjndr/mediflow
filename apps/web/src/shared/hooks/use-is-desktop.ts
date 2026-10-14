import { useSyncExternalStore } from 'react';

/** Tailwind's `lg`: where the sidebar and the full layout begin (CLAUDE.md, Responsive Design). */
const DESKTOP = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(DESKTOP);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** Wide enough for a desktop-only screen. A browser that cannot say counts as wide. */
const isDesktop = () =>
  typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP).matches;

/**
 * Whether the window is at desktop width now, following it as it is resized or turned. For a
 * desktop-only screen (`DesktopOnly`), or a desktop-only view, such as a week calendar, beside
 * views that work at any width. Layout by width, never by device.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, isDesktop, () => true);
}
