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
  ],
  nav: { icon: Users, order: 20, requires: ['patient:read'] },
  permissions: ['patient:read'],
};
