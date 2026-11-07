import { SprayCan } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Housekeeping (#198): the bed cleaning tasks the server makes when a patient leaves a bed. A
 * person starts one and finishes it, and finishing makes the bed available again. It refers to
 * beds and wards by id and name only.
 */
export const housekeepingFeature: FeatureManifest = {
  id: 'housekeeping',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Housekeeping' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital (finishing also needs `wards`).
  featureFlag: 'housekeeping',
  routes: [
    {
      path: 'housekeeping',
      lazy: () => import('./routes/CleaningTasks'),
      requires: ['cleaningTask:read'],
    },
  ],
  nav: { icon: SprayCan, order: 82, requires: ['cleaningTask:read'] },
  permissions: ['cleaningTask:read', 'cleaningTask:work', 'cleaningTask:manage'],
};
