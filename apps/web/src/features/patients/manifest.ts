import { Users } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/** Patients: the register of people the hospital treats. Staff-only; patients never sign in. */
export const patientsFeature: FeatureManifest = {
  id: 'patients',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Patients' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  featureFlag: 'patients',
  routes: [
    { path: 'patients', lazy: () => import('./routes/PatientList'), requires: ['patient:read'] },
    {
      path: 'patients/new',
      lazy: () => import('./routes/PatientCreate'),
      requires: ['patient:create'],
    },
  ],
  nav: { icon: Users, order: 20, requires: ['patient:read'] },
  permissions: ['patient:read', 'patient:create'],
};
