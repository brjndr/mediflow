import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { SystemPage } from './system-page';

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

/** Whether the window is at desktop width now, following it as it is resized or turned. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, isDesktop, () => true);
}

/**
 * For a screen on the desktop-only list in CLAUDE.md. Below desktop width it shows a short
 * notice inside the shell instead of a layout that does not fit, and the screen itself is not
 * mounted, so it asks the server for nothing. Putting a screen on that list is a decision
 * recorded in CLAUDE.md, not something this component decides.
 */
export function DesktopOnly({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  if (useIsDesktop()) return children;
  return <SystemPage title={t('desktopOnly.title')} description={t('desktopOnly.description')} />;
}
