import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { usePermission } from '@/access';
import { cn } from '@/shared/lib/utils';

const item =
  'inline-flex h-9 items-center px-3 text-sm font-medium first:rounded-l-md last:rounded-r-md pointer-coarse:h-11';

/** Between the three lists of the records desk, each shown to the permission that opens it. */
export function RecordsNav() {
  const { t } = useTranslation('records');
  const canReview = usePermission('medicalRecord:read');
  const canRequests = usePermission('recordRequest:read');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(item, isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted');
  return (
    <nav aria-label={t('nav.label')} className="inline-flex self-start rounded-md border">
      {canReview && (
        <NavLink to="/records" end className={link}>
          {t('nav.incomplete')}
        </NavLink>
      )}
      {canReview && (
        <NavLink to="/records/coding" className={link}>
          {t('nav.coding')}
        </NavLink>
      )}
      {canRequests && (
        <NavLink to="/records/requests" className={link}>
          {t('nav.requests')}
        </NavLink>
      )}
    </nav>
  );
}
