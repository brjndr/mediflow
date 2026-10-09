import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useNavItems } from '@/registry';
import { cn } from '@/shared/lib/utils';

/** Navigation generated from the feature registry. F-10 turns this into the sidebar. */
export function AppNav() {
  const { t } = useTranslation();
  const items = useNavItems();
  if (items.length === 0) return null;
  return (
    <nav aria-label={t('nav.label')}>
      <ul className="flex items-center gap-1">
        {items.map(({ featureId, titleKey, to, icon: Icon }) => (
          <li key={featureId}>
            <NavLink
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isActive && 'bg-accent font-medium',
                )
              }
            >
              <Icon className="size-4" />
              {t(titleKey)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
