import { Boxes } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Inventory (#102): the stock of every item of the drug and consumable master, by batch and
 * place, with low and expiring alerts; adjustments asked for by one person and approved by
 * another; the append-only ledger of every change; and the places that keep stock. Dispensing,
 * goods receipts and indents post to the same ledger. Works at every width.
 */
export const inventoryFeature: FeatureManifest = {
  id: 'inventory',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Inventory',
        adjustments: 'Stock adjustments',
        ledger: 'Stock ledger',
        locations: 'Stock places',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'inventory',
  routes: [
    { path: 'inventory', lazy: () => import('./routes/StockList'), requires: ['stock:read'] },
    {
      path: 'inventory/adjustments',
      titleKey: 'adjustments',
      lazy: () => import('./routes/StockAdjustments'),
      requires: ['stock:read'],
    },
    {
      path: 'inventory/ledger',
      titleKey: 'ledger',
      lazy: () => import('./routes/StockLedger'),
      requires: ['stock:read'],
    },
    {
      path: 'inventory/locations',
      titleKey: 'locations',
      lazy: () => import('./routes/StockLocations'),
      requires: ['stock:read'],
    },
  ],
  nav: { icon: Boxes, order: 29.8, requires: ['stock:read'] },
  permissions: ['stock:read', 'stock:adjust', 'stock:approve', 'stockLocation:manage'],
};
