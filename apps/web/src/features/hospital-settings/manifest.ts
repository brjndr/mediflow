import { Settings } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The hospital settings screen (#992): one page that renders the `settings.sections` slot, so a
 * module puts its own rules there with a contribution and nothing here changes. It has no
 * permissions or flag of its own: each section declares what it needs, and the route stays open
 * and shows a notice when no section is allowed.
 */
export const hospitalSettingsFeature: FeatureManifest = {
  id: 'hospital-settings',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Hospital settings' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  routes: [{ path: 'settings', lazy: () => import('./routes/SettingsPage'), requires: [] }],
  // Offered to the people who can change the one section there is today (admissions). A section
  // with another permission needs a nav entry for that permission in a later change.
  nav: { icon: Settings, order: 830, requires: ['admission:configure'] },
  // Not owned here: named so the navigation entry can require it.
  permissions: ['admission:configure'],
};
