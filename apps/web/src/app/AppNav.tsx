import { Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useNavItems } from '@/registry';
import { cn } from '@/shared/lib/utils';

interface AppNavProps {
  /** Show icons only. Each link keeps its name for assistive technology and as a tooltip. */
  collapsed?: boolean;
  /** Called when a link is followed, so a drawer can close itself. */
  onNavigate?: () => void;
}

/** Main navigation: Home, then one item per enabled feature the user may open, from the registry. */
export function AppNav({ collapsed = false, onNavigate }: AppNavProps) {
  const { t } = useTranslation();
  const features = useNavItems();
  const items = [
    { key: 'home', to: '/', label: t('nav.home'), icon: Home, end: true },
    ...features.map(({ featureId, titleKey, to, icon }) => ({
      key: featureId,
      to,
      label: t(titleKey),
      icon,
      end: false,
    })),
  ];

  return (
    <nav aria-label={t('nav.label')}>
      <ul className="flex flex-col gap-1">
        {items.map(({ key, to, label, icon: Icon, end }) => (
          <li key={key}>
            <NavLink
              to={to}
              end={end}
              title={collapsed ? label : undefined}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-9 items-center gap-3 rounded-md px-3 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  collapsed && 'justify-center px-0',
                  isActive && 'bg-accent font-medium',
                )
              }
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
