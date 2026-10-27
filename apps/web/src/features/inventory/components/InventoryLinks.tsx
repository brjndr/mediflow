import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium text-muted-foreground underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-[current=page]:no-underline pointer-coarse:min-h-11';

/**
 * The screens of inventory, one link each, the current one marked (`aria-current`). Each screen
 * needs `stock:read`, as its route does, so every link shows to whoever sees one.
 */
export function InventoryLinks() {
  const { t } = useTranslation('inventory');
  return (
    <nav aria-label={t('links.label')} className="flex flex-wrap gap-x-6 gap-y-1">
      <NavLink end to="/inventory" className={link}>
        {t('links.stock')}
      </NavLink>
      <NavLink to="/inventory/adjustments" className={link}>
        {t('links.adjustments')}
      </NavLink>
      <NavLink to="/inventory/ledger" className={link}>
        {t('links.ledger')}
      </NavLink>
      <NavLink to="/inventory/locations" className={link}>
        {t('links.locations')}
      </NavLink>
    </nav>
  );
}
