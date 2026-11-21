import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { Can } from '@/access';
import { subNavLink } from '@/shared/ui/link-styles';

/**
 * The screens of inventory, one link each, the current one marked (`aria-current`). Each screen
 * needs `stock:read`, as its route does, so every link shows to whoever sees one; the indents
 * (#105, their own module) show for `indent:read`.
 */
export function InventoryLinks() {
  const { t } = useTranslation('inventory');
  return (
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-2">
      <NavLink end to="/inventory" className={subNavLink}>
        {t('links.stock')}
      </NavLink>
      <NavLink to="/inventory/adjustments" className={subNavLink}>
        {t('links.adjustments')}
      </NavLink>
      <NavLink to="/inventory/ledger" className={subNavLink}>
        {t('links.ledger')}
      </NavLink>
      <NavLink to="/inventory/locations" className={subNavLink}>
        {t('links.locations')}
      </NavLink>
      <Can permission="indent:read">
        <NavLink to="/inventory/indents" className={subNavLink}>
          {t('links.indents')}
        </NavLink>
      </Can>
    </nav>
  );
}
