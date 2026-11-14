import { Building } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The hospital profile: the address, phone, registration number and GSTIN that are printed on
 * the letterhead of prescriptions, invoices and the rest. The API has no module switch for it
 * (like roles), so the manifest declares no flag: only the permissions apply.
 */
export const hospitalProfileFeature: FeatureManifest = {
  id: 'hospital-profile',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Hospital profile' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  routes: [
    {
      path: 'hospital-profile',
      lazy: () => import('./routes/HospitalProfilePage'),
      requires: ['hospitalProfile:read'],
    },
  ],
  nav: { icon: Building, order: 820, requires: ['hospitalProfile:read'] },
  permissions: ['hospitalProfile:read', 'hospitalProfile:manage'],
};
