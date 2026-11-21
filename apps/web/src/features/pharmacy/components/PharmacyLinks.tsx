import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { usePermission } from '@/access';
import { subNavLink } from '@/shared/ui/link-styles';

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
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-2">
      {queue && (
        <NavLink end to="/pharmacy" className={subNavLink}>
          {t('links.queue')}
        </NavLink>
      )}
      {sales && (
        <NavLink to="/pharmacy/sales" className={subNavLink}>
          {t('links.sales')}
        </NavLink>
      )}
      {register && (
        <NavLink to="/pharmacy/register" className={subNavLink}>
          {t('links.register')}
        </NavLink>
      )}
    </nav>
  );
}
