import type { FeatureManifest } from '@/registry';

/**
 * Patient documents (#189): scanned reports and outside records kept on a patient's record, as a
 * tab of the patient's screen (`patient.detail.tabs`). The API is `features/documents` (#194).
 * No route and no navigation item: documents are always about one patient. Works at every width.
 */
export const documentsFeature: FeatureManifest = {
  id: 'documents',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Documents' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'documents',
  routes: [],
  permissions: ['document:read', 'document:upload', 'document:retire'],
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/DocumentsTab'),
      requires: ['document:read'],
      order: 40,
    },
  ],
};
