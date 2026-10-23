import { TestTube } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * The laboratory (#90): the worklist of lab orders, collecting their samples with an accession id
 * and a printed barcode label, receiving them, and rejecting one to be collected again. Orders
 * come from the consultation (`order.placed`); the tests are the lab test catalog's. Results are
 * #91 and reports #92. Built against the planned contract and the mock until the laboratory API
 * (#95) serves it. Works at every width: a nurse collects at the bedside.
 */
export const labFeature: FeatureManifest = {
  id: 'lab',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Laboratory' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'laboratory',
  routes: [
    { path: 'lab', lazy: () => import('./routes/LabWorklist'), requires: ['labSample:read'] },
  ],
  nav: { icon: TestTube, order: 29.5, requires: ['labSample:read'] },
  permissions: ['labSample:read', 'labSample:collect', 'labSample:receive', 'labSample:reject'],
};
