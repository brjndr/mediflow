import { Tags } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The service and tariff catalog: everything the hospital can charge for (a consultation, a
 * procedure, a bed day, a test, a scan, a package) and what each costs from which date. Charges
 * are priced from it when they are posted, so a later price never changes an old bill.
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const servicesFeature: FeatureManifest = {
  id: 'services',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Services and prices', create: 'Add a service', record: 'Service' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'services',
  routes: [
    { path: 'services', lazy: () => import('./routes/ServiceList'), requires: ['service:read'] },
    {
      path: 'services/new',
      titleKey: 'create',
      lazy: () => import('./routes/ServiceCreate'),
      requires: ['service:manage'],
    },
    {
      path: 'services/:serviceId',
      titleKey: 'record',
      lazy: () => import('./routes/ServiceDetail'),
      requires: ['service:read'],
    },
  ],
  nav: { icon: Tags, order: 50, requires: ['service:read'] },
  permissions: ['service:read', 'service:manage'],
};
