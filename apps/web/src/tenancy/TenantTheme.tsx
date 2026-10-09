import { useEffect } from 'react';
import { applyTheme, resetTheme, themeFromBrandColor } from '@/shared/lib/theme';
import { useTenant } from './tenant-context';

/**
 * Applies the active hospital's brand colour and removes it when there is no hospital, so the
 * login page stays generic and one hospital's colour never carries over to the next. A colour
 * that is malformed or too pale to read is ignored and the default theme stays.
 */
export function TenantTheme() {
  const primary = useTenant()?.theme.primary;

  useEffect(() => {
    const theme = primary ? themeFromBrandColor(primary) : null;
    if (!theme) return;
    applyTheme(theme);
    return () => resetTheme();
  }, [primary]);

  return null;
}
