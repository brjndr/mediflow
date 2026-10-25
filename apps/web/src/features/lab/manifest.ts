import { TestTube } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The laboratory (#90, #91): the worklist of lab orders, collecting their samples with an
 * accession id and a printed barcode label, receiving them, and rejecting one to be collected
 * again; then each order's results, entered, verified and corrected with their history. Orders
 * come from the consultation (`order.placed`); the tests are the lab test catalog's. Reports
 * (#92): the printed report, the released results in the consultation (`LabResultsPanel`) and on
 * the patient's screen (a tab, with each test's trend), and a doctor acknowledging a critical one.
 * Works at every width: a nurse collects at the bedside.
 */
export const labFeature: FeatureManifest = {
  id: 'lab',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Laboratory', results: 'Lab results' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'laboratory',
  routes: [
    { path: 'lab', lazy: () => import('./routes/LabWorklist'), requires: ['labSample:read'] },
    {
      path: 'lab/orders/:orderId',
      titleKey: 'results',
      lazy: () => import('./routes/LabResults'),
      requires: ['labResult:read'],
    },
  ],
  nav: { icon: TestTube, order: 29.5, requires: ['labSample:read'] },
  permissions: [
    'labSample:read',
    'labSample:collect',
    'labSample:receive',
    'labSample:reject',
    'labSample:outsource',
    'labResult:read',
    'labResult:enter',
    'labResult:verify',
    'labResult:acknowledge',
    'labReport:print',
  ],
  extensions: [
    // The patient's released results, with each test's trend (#92).
    {
      slot: 'patient.detail.tabs',
      component: () => import('./components/LabResultsTab'),
      requires: ['labResult:read'],
      order: 35,
    },
  ],
};
