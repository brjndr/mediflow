import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsDesktop } from '@/shared/hooks/use-is-desktop';
import { SystemPage } from './system-page';

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
