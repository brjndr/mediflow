import { Ambulance } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Ambulances (#197): the fleet, trip requests and dispatch. It refers to patients by id only
 * (named through the patients feature's exports). Charging a trip to the encounter has no API
 * yet (see this folder's CLAUDE.md).
 */
export const ambulancesFeature: FeatureManifest = {
  id: 'ambulances',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Ambulances' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'ambulance',
  routes: [
    {
      path: 'ambulances',
      lazy: () => import('./routes/Ambulances'),
      requires: ['ambulance:read'],
    },
  ],
  nav: { icon: Ambulance, order: 83, requires: ['ambulance:read'] },
  permissions: ['ambulance:read', 'ambulance:manage', 'ambulance:dispatch'],
};
