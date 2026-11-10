import { Scissors } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Operation theatre scheduling (#176): theatres and the day's surgeries, booked, moved,
 * started, completed and cancelled. It refers to patients and surgeons by id (named through the
 * patients and doctors features' exports). The server refuses overlaps (see this folder's CLAUDE.md).
 */
export const theatreFeature: FeatureManifest = {
  id: 'theatre',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Operation theatre' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'theatre',
  routes: [
    {
      path: 'theatre',
      lazy: () => import('./routes/Theatre'),
      requires: ['theatre:read'],
    },
  ],
  nav: { icon: Scissors, order: 84, requires: ['theatre:read'] },
  permissions: ['theatre:read', 'theatre:manage', 'surgery:schedule', 'surgery:perform'],
};
