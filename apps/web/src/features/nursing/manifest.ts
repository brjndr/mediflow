import { HeartPulse } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Nursing and ward care (#157, R2). The nursing worklist: the patients now on the wards, by ward,
 * and the vital signs chart of a stay with its trend, an early warning score and corrections.
 * Built on the nursing API (BE-24); it refers to admissions by id.
 */
export const nursingFeature: FeatureManifest = {
  id: 'nursing',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Ward care', vitals: 'Vital signs' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital (it also needs `admissions`).
  featureFlag: 'nursing',
  routes: [
    {
      path: 'nursing',
      lazy: () => import('./routes/Worklist'),
      requires: ['admission:read', 'nursingVitals:read'],
    },
    {
      path: 'nursing/:admissionId/vitals',
      titleKey: 'vitals',
      lazy: () => import('./routes/WardVitals'),
      requires: ['nursingVitals:read'],
    },
  ],
  nav: { icon: HeartPulse, order: 82.5, requires: ['admission:read', 'nursingVitals:read'] },
  permissions: ['admission:read', 'nursingVitals:read', 'nursingVitals:record'],
};
