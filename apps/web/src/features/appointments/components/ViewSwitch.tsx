import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { cn } from '@/shared/lib/utils';

const item =
  'inline-flex h-9 items-center px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11';

/** Between the list and the calendar of appointments. Both need only `appointment:read`. */
export function ViewSwitch() {
  const { t } = useTranslation('appointments');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      item,
      isActive
        ? 'bg-brand-gradient font-semibold text-primary-foreground'
        : 'text-primary-ink hover:bg-primary-soft',
    );
  return (
    <nav
      aria-label={t('views.label')}
      className="inline-flex overflow-hidden rounded-lg border border-primary/30 bg-card shadow-tinted"
    >
      <NavLink to="/appointments" end className={link}>
        {t('views.list')}
      </NavLink>
      <NavLink to="/appointments/calendar" className={link}>
        {t('views.calendar')}
      </NavLink>
    </nav>
  );
}
