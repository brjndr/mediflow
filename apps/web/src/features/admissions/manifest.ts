import { BedSingle } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Admissions, discharge and transfer (R2). So far the bed board (#151): every bed in use by ward
 * and status, who is in it, kept live by the server's events, with cleaning and ready marked by
 * housekeeping and blocking from the wards API. It refers to wards and patients by id.
 */
export const admissionsFeature: FeatureManifest = {
  id: 'admissions',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Bed board' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital (it also needs `wards`).
  featureFlag: 'admissions',
  routes: [{ path: 'beds', lazy: () => import('./routes/BedBoard'), requires: ['admission:read'] }],
  nav: { icon: BedSingle, order: 81, requires: ['admission:read'] },
  permissions: ['admission:read', 'bed:update'],
};
