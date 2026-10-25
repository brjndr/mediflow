import { ScanLine } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Radiology (#96): the worklist of imaging orders, scheduling each study for a slot, moving or
 * unscheduling it, and recording that it was performed. Orders come from the consultation
 * (`order.placed`); the studies are the services catalog's imaging services, sorted by their
 * modality. Reports and their sign-off are #97. Works at every width.
 */
export const radiologyFeature: FeatureManifest = {
  id: 'radiology',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Radiology' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'radiology',
  routes: [
    {
      path: 'radiology',
      lazy: () => import('./routes/RadiologyWorklist'),
      requires: ['imagingStudy:read'],
    },
  ],
  nav: { icon: ScanLine, order: 29.7, requires: ['imagingStudy:read'] },
  permissions: ['imagingStudy:read', 'imagingStudy:schedule', 'imagingStudy:perform'],
};
