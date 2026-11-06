import { Activity } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Triage (#77): a nurse records a patient's vitals, chief complaint and allergies before the
 * consultation, with values outside the hospital's normal ranges marked. Reached from a token of
 * the queue board (the `queue.row.actions` slot) and from the patient's screen (a "Vitals and
 * allergies" tab in `patient.detail.tabs`); `TriageSummary` shows it to the doctor. No nav item:
 * triage is always about one patient.
 */
export const triageFeature: FeatureManifest = {
  id: 'triage',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Triage', record: 'Record vitals', ranges: 'Vital sign ranges' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'triage',
  routes: [
    {
      // `?token=<id>` from the queue, `?corrects=<id>` to correct a reading. Ids only.
      path: 'triage/:patientId',
      titleKey: 'record',
      lazy: () => import('./routes/RecordVitals'),
      // Reading the ranges and the earlier readings needs `vitals:read` too.
      requires: ['vitals:record', 'vitals:read'],
    },
    {
      // The hospital's normal ranges by age band (#378, #379): a desktop-only screen.
      path: 'triage/ranges',
      titleKey: 'ranges',
      lazy: () => import('./routes/VitalRanges'),
      requires: ['vitals:configure', 'vitals:read'],
    },
  ],
  // Triage is about one patient, so its one nav item is for setting it up.
  nav: { icon: Activity, order: 85, requires: ['vitals:configure'], path: 'triage/ranges' },
  permissions: [
    'vitals:read',
    'vitals:record',
    'vitals:configure',
    'allergy:read',
    'allergy:update',
  ],
  extensions: [
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/VitalsTab'),
      order: 20,
    },
    {
      slot: 'queue.row.actions',
      component: () => import('./components/RecordVitalsLink'),
      requires: ['vitals:record', 'vitals:read'],
      order: 10,
    },
  ],
};
