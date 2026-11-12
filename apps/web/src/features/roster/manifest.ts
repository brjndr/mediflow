import { CalendarClock } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Duty rosters (OP-01, #195): who is on duty when, by department, with shift templates and the
 * people on call now. Works at every width. Runs on the real operations API.
 */
export const rosterFeature: FeatureManifest = {
  id: 'roster',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Duty roster' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'roster',
  routes: [
    { path: 'roster', lazy: () => import('./routes/RosterPage'), requires: ['roster:read'] },
  ],
  nav: { icon: CalendarClock, order: 795, requires: ['roster:read'] },
  permissions: ['roster:read', 'roster:manage', 'roster:requestLeave'],
};
