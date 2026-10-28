import { ClipboardList } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Indents (#105): a ward, a department or the pharmacy counter asks a store for items, someone
 * who did not ask approves it, and the store issues it on vouchers that move stock out of the
 * store and into the place that asked. The API is inventory's, behind the same `inventory`
 * switch; a module of its own here so a nurse, who indents but does not see the stock, has it in
 * the navigation. Works at every width.
 */
export const indentsFeature: FeatureManifest = {
  id: 'indents',
  titleKey: 'title',
  i18n: {
    titles: {
      en: { title: 'Indents', new: 'New indent', detail: 'Indent' },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Inventory's switch: off by default, enabled per hospital by a platform admin.
  featureFlag: 'inventory',
  routes: [
    {
      path: 'inventory/indents',
      lazy: () => import('./routes/Indents'),
      requires: ['indent:read'],
    },
    {
      path: 'inventory/indents/new',
      titleKey: 'new',
      lazy: () => import('./routes/IndentEditor'),
      requires: ['indent:read', 'indent:create'],
    },
    {
      path: 'inventory/indents/:indentId',
      titleKey: 'detail',
      lazy: () => import('./routes/IndentDetail'),
      requires: ['indent:read'],
    },
  ],
  nav: { icon: ClipboardList, order: 29.85, requires: ['indent:read'] },
  permissions: ['indent:read', 'indent:create', 'indent:approve', 'indent:issue'],
};
