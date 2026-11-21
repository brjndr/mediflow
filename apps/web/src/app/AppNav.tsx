import { Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { useNavItems } from '@/registry';
import { cn } from '@/shared/lib/utils';

/**
 * Each item's icon sits on a chip of one of the five accent hues, in turn (#1119). Decorative:
 * the item is named by its label, and the current one is also bold with `aria-current`.
 */
const CHIPS = [
  'bg-accent-1-soft text-accent-1',
  'bg-accent-2-soft text-accent-2',
  'bg-accent-3-soft text-accent-3',
  'bg-accent-4-soft text-accent-4',
  'bg-accent-5-soft text-accent-5',
] as const;

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
      <ul className="flex flex-col gap-1.5">
        {items.map(({ key, to, label, icon: Icon, end }, index) => (
          <li key={key}>
            <NavLink
              to={to}
              end={end}
              title={collapsed ? label : undefined}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'group flex h-10 items-center gap-3 rounded-lg px-2 text-sm pointer-coarse:h-11 outline-none transition-[background-color,box-shadow] hover:bg-primary-soft focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  collapsed && 'justify-center px-0',
                  isActive &&
                    'bg-brand-gradient font-semibold text-primary-foreground shadow-button hover:bg-brand-gradient',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-md',
                      isActive
                        ? 'bg-white/20 text-primary-foreground'
                        : CHIPS[index % CHIPS.length],
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
