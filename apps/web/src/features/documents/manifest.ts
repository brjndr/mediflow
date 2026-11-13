import { Archive } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Patient documents (#189): scanned reports and outside records kept on a patient's record, as a
 * tab of the patient's screen (`patient.detail.tabs`). The API is `features/documents` (#194).
 * The tab has no route; the retention rules screen (#561) is `/document-retention`. Works at every width.
 */
export const documentsFeature: FeatureManifest = {
  id: 'documents',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Document retention' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'documents',
  routes: [
    {
      path: 'document-retention',
      lazy: () => import('./routes/RetentionPage'),
      requires: ['documentRetention:read'],
    },
  ],
  nav: { icon: Archive, order: 797, requires: ['documentRetention:read'] },
  permissions: [
    'document:read',
    'document:upload',
    'document:retire',
    'documentRetention:read',
    'documentRetention:manage',
  ],
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/DocumentsTab'),
      requires: ['document:read'],
      order: 40,
    },
    {
      slot: 'encounter.detail.actions',
      component: () => import('./components/EncounterDocuments'),
      requires: ['document:read'],
      order: 60,
    },
  ],
};
