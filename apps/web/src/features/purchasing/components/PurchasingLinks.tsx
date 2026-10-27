import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Can } from '@/access';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium text-muted-foreground underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-[current=page]:no-underline pointer-coarse:min-h-11';

/**
 * The screens of purchasing, one link each, the current one marked (`aria-current`), each shown
 * for what its route requires.
 */
export function PurchasingLinks() {
  const { t } = useTranslation('purchasing');
  return (
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-x-6 gap-y-1">
      <Can permission="purchaseOrder:read">
        <NavLink end to="/purchasing" className={link}>
          {t('links.orders')}
        </NavLink>
        <NavLink to="/purchasing/receipts" className={link}>
          {t('links.receipts')}
        </NavLink>
        <NavLink to="/purchasing/returns" className={link}>
          {t('links.returns')}
        </NavLink>
      </Can>
      <Can permission="supplier:read">
        <NavLink to="/purchasing/suppliers" className={link}>
          {t('links.suppliers')}
        </NavLink>
      </Can>
    </nav>
  );
}
