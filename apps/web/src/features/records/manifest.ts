import { FolderCheck } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The medical records department's tools (MR-04, #192): closed encounters whose record is
 * incomplete, the queue of diagnoses written as text that still need an ICD-10 code, and the log
 * of requests for copies of a record. Works at every width. Until the API has them the screens
 * run on the mock (the endpoints are in the planned contract).
 */
export const recordsFeature: FeatureManifest = {
  id: 'records',
  titleKey: 'title',
  i18n: {
    titles: {
      en: { title: 'Medical records', coding: 'Coding queue', requests: 'Record requests' },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'records',
  routes: [
    {
      path: 'records',
      lazy: () => import('./routes/IncompleteRecords'),
      requires: ['medicalRecord:read'],
    },
    {
      path: 'records/coding',
      titleKey: 'coding',
      lazy: () => import('./routes/CodingQueue'),
      requires: ['medicalRecord:read'],
    },
    {
      path: 'records/requests',
      titleKey: 'requests',
      lazy: () => import('./routes/RecordRequests'),
      requires: ['recordRequest:read'],
    },
  ],
  nav: { icon: FolderCheck, order: 29.95, requires: ['medicalRecord:read'] },
  permissions: [
    'medicalRecord:read',
    'medicalRecord:code',
    'recordRequest:read',
    'recordRequest:manage',
  ],
};
