import { FlaskConical } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The lab test catalog: the tests and panels the laboratory offers, how each is collected, how
 * its result is read (the reference ranges by age and sex) and the service it is charged as.
 * Orders and the laboratory refer to these tests by id. Samples and results are not here: they
 * belong to the laboratory.
 *
 * Master data: a desktop-only screen (CLAUDE.md, Responsive Design).
 */
export const labTestsFeature: FeatureManifest = {
  id: 'lab_tests',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Lab tests', create: 'Add a lab test', record: 'Lab test' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'lab_tests',
  routes: [
    { path: 'lab-tests', lazy: () => import('./routes/LabTestList'), requires: ['labTest:read'] },
    {
      path: 'lab-tests/new',
      titleKey: 'create',
      lazy: () => import('./routes/LabTestCreate'),
      requires: ['labTest:manage'],
    },
    {
      path: 'lab-tests/:labTestId',
      titleKey: 'record',
      lazy: () => import('./routes/LabTestDetail'),
      requires: ['labTest:read'],
    },
  ],
  nav: { icon: FlaskConical, order: 70, requires: ['labTest:read'] },
  permissions: ['labTest:read', 'labTest:manage'],
};
