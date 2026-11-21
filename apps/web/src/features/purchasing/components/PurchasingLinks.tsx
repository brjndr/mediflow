import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { Can } from '@/access';
import { subNavLink } from '@/shared/ui/button';

/**
 * The screens of purchasing, one link each, the current one marked (`aria-current`), each shown
 * for what its route requires.
 */
export function PurchasingLinks() {
  const { t } = useTranslation('purchasing');
  return (
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-2">
      <Can permission="purchaseOrder:read">
        <NavLink end to="/purchasing" className={subNavLink}>
          {t('links.orders')}
        </NavLink>
        <NavLink to="/purchasing/receipts" className={subNavLink}>
          {t('links.receipts')}
        </NavLink>
        <NavLink to="/purchasing/returns" className={subNavLink}>
          {t('links.returns')}
        </NavLink>
      </Can>
      <Can permission="supplier:read">
        <NavLink to="/purchasing/suppliers" className={subNavLink}>
          {t('links.suppliers')}
        </NavLink>
      </Can>
    </nav>
  );
}
