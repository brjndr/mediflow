/**
 * The light / dark / system choice. A theme name is the only thing kept, in `localStorage` (no
 * PHI). `index.html` applies it before first paint with the same key and rule; keep them in step.
 */
export type SchemeChoice = 'light' | 'dark' | 'system';

export const SCHEME_KEY = 'mediflow.theme';
export const SCHEME_CHOICES: readonly SchemeChoice[] = ['light', 'dark', 'system'];

export function readSchemeChoice(): SchemeChoice {
  try {
    const value = window.localStorage.getItem(SCHEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function storeSchemeChoice(choice: SchemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(SCHEME_KEY);
    else window.localStorage.setItem(SCHEME_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
}

const query = '(prefers-color-scheme: dark)';

export function isDarkFor(choice: SchemeChoice): boolean {
  return (
    choice === 'dark' || (choice === 'system' && (window.matchMedia?.(query).matches ?? false))
  );
}

/** Puts `.dark` on the root (what the tokens answer to) and tells the browser its scheme. */
export function applySchemeChoice(choice: SchemeChoice): void {
  const dark = isDarkFor(choice);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/** Re-applies while the choice is `system` and the device changes. Returns the unsubscribe. */
export function watchSystemScheme(getChoice: () => SchemeChoice): () => void {
  const media = window.matchMedia?.(query);
  if (!media) return () => undefined;
  const onChange = () => {
    if (getChoice() === 'system') applySchemeChoice('system');
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
