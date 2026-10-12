import { BedDouble } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Wards, rooms and beds: where the hospital can put a patient, and the bed categories that
 * decide what a day in a bed is charged as. Admissions refer to beds by id. Who is in a bed is
 * not here: that is the admissions module, which also makes a bed occupied; from this screen a
 * bed is only blocked and put back in use.
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const wardsFeature: FeatureManifest = {
  id: 'wards',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Wards and beds' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'wards',
  routes: [
    { path: 'wards', lazy: () => import('./routes/WardList'), requires: ['ward:read'] },
    { path: 'wards/new', lazy: () => import('./routes/WardCreate'), requires: ['ward:manage'] },
    {
      path: 'wards/categories',
      lazy: () => import('./routes/BedCategories'),
      requires: ['ward:read'],
    },
    { path: 'wards/:wardId', lazy: () => import('./routes/WardDetail'), requires: ['ward:read'] },
  ],
  nav: { icon: BedDouble, order: 80, requires: ['ward:read'] },
  permissions: ['ward:read', 'ward:manage'],
};
