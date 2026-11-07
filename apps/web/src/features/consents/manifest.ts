import type { FeatureManifest } from '@/registry';

/**
 * Consents and certificates (MR-02, #190): signed consent forms made from the hospital's consent
 * templates, and medical, fitness, birth and death certificates, as a tab of the patient's screen
 * (`patient.detail.tabs`). No route and no navigation item: they are always about one patient.
 * Works at every width. Until the API has them the screen runs on the mock (the endpoints are in
 * the planned contract).
 */
export const consentsFeature: FeatureManifest = {
  id: 'consents',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Consents and certificates' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'consents',
  routes: [],
  permissions: ['consent:read', 'consent:sign', 'certificate:read', 'certificate:issue'],
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/ConsentsTab'),
      // Either list is enough to show the tab; the tab shows only the parts the caller may read.
      requires: [],
      order: 45,
    },
  ],
};
