import { Droplets } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Blood bank (#196): blood units from collection to transfusion, the stock that can be given now
 * and the history of each unit. A patient is named by id only and looked up when shown.
 */
export const bloodBankFeature: FeatureManifest = {
  id: 'blood-bank',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Blood bank' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'bloodbank',
  routes: [
    {
      path: 'blood-bank',
      lazy: () => import('./routes/BloodBank'),
      requires: ['bloodUnit:read'],
    },
  ],
  nav: { icon: Droplets, order: 84, requires: ['bloodUnit:read'] },
  permissions: ['bloodUnit:read', 'bloodUnit:manage', 'bloodUnit:issue'],
};
