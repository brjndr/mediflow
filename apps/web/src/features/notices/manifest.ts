import { Megaphone } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Staff notices: the sample feature and the template for new modules. Everything the app needs to
 * know about the feature is declared here; core has no code that mentions it.
 *
 * To start a new feature, copy this folder, rename the ids, and add one line to
 * `registry/features.ts`.
 */
export const noticesFeature: FeatureManifest = {
  id: 'notices',
  titleKey: 'title',
  i18n: {
    // Bundled with the manifest: only what core shows before this feature's code loads.
    titles: { en: { title: 'Notices' } },
    // Screen strings, loaded when a notices screen first renders.
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'notices',
  routes: [
    { path: 'notices', lazy: () => import('./routes/NoticesPage'), requires: ['notice:read'] },
  ],
  nav: { icon: Megaphone, order: 900, requires: ['notice:read'] },
  permissions: ['notice:read', 'notice:manage'],
  dashboardWidgets: [
    {
      id: 'latest',
      component: () => import('./components/LatestNoticesWidget'),
      requires: ['notice:read'],
    },
  ],
  settings: {
    section: 'notices',
    // Loaded on demand: the manifest is part of the initial bundle, so it must not import Zod.
    schema: () => import('./settings').then((module) => module.noticesSettingsSchema),
    requires: ['notice:manage'],
  },
};
