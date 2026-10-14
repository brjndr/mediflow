import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { cn } from '@/shared/lib/utils';

const item =
  'inline-flex h-9 items-center px-3 text-sm font-medium first:rounded-l-md last:rounded-r-md pointer-coarse:h-11';

/** Between the list and the calendar of appointments. Both need only `appointment:read`. */
export function ViewSwitch() {
  const { t } = useTranslation('appointments');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(item, isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted');
  return (
    <nav aria-label={t('views.label')} className="inline-flex rounded-md border">
      <NavLink to="/appointments" end className={link}>
        {t('views.list')}
      </NavLink>
      <NavLink to="/appointments/calendar" className={link}>
        {t('views.calendar')}
      </NavLink>
    </nav>
  );
}
