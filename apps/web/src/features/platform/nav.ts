import { Building2, LayoutDashboard } from 'lucide-react';
import type { ComponentType } from 'react';

export interface PlatformNavItem {
  key: string;
  /** Key in core `common`. */
  labelKey: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

/**
 * The platform administrator's own navigation. It is not generated from the feature registry: the
 * registry is per hospital and holds only screens of a hospital's own data, and a platform admin
 * has no hospital. The hospital, module and audit screens (PL-02 onwards) add their items here.
 */
export const PLATFORM_NAV: PlatformNavItem[] = [
  {
    key: 'overview',
    labelKey: 'platform.nav.overview',
    to: '/platform',
    icon: LayoutDashboard,
    end: true,
  },
  {
    key: 'hospitals',
    labelKey: 'platform.nav.hospitals',
    to: '/platform/hospitals',
    icon: Building2,
  },
];
