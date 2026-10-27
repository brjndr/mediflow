import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { usePermission } from '@/access';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium text-muted-foreground underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-[current=page]:no-underline pointer-coarse:min-h-11';

/**
 * The screens of the pharmacy, one link each, the current one marked (`aria-current`): the
 * prescription queue, counter sales and the drug register (#101), each shown to whoever holds
 * what its route requires.
 */
export function PharmacyLinks() {
  const { t } = useTranslation('pharmacy');
  const queue = usePermission('dispense:read');
  const sales = usePermission('sale:read');
  const register = usePermission('drugRegister:read');
  return (
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-x-6 gap-y-1">
      {queue && (
        <NavLink end to="/pharmacy" className={link}>
          {t('links.queue')}
        </NavLink>
      )}
      {sales && (
        <NavLink to="/pharmacy/sales" className={link}>
          {t('links.sales')}
        </NavLink>
      )}
      {register && (
        <NavLink to="/pharmacy/register" className={link}>
          {t('links.register')}
        </NavLink>
      )}
    </nav>
  );
}
