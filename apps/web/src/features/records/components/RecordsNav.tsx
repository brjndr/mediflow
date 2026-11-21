import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { usePermission } from '@/access';
import { cn } from '@/shared/lib/utils';

const item =
  'inline-flex h-9 items-center px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11';

/** Between the three lists of the records desk, each shown to the permission that opens it. */
export function RecordsNav() {
  const { t } = useTranslation('records');
  const canReview = usePermission('medicalRecord:read');
  const canRequests = usePermission('recordRequest:read');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      item,
      isActive
        ? 'bg-brand-gradient font-semibold text-primary-foreground'
        : 'text-primary-ink hover:bg-primary-soft',
    );
  return (
    <nav
      aria-label={t('nav.label')}
      className="inline-flex self-start overflow-hidden rounded-lg border border-primary/30 bg-card shadow-tinted"
    >
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
