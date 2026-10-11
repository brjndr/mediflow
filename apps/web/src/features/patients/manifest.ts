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
    {
      path: 'patients/:id',
      lazy: () => import('./routes/PatientDetail'),
      requires: ['patient:read'],
    },
    {
      // Both: changing a record shows it.
      path: 'patients/:id/edit',
      lazy: () => import('./routes/PatientEdit'),
      requires: ['patient:read', 'patient:update'],
    },
  ],
  // A link to a patient (an email, a notification) opens the record at its own hospital.
  links: [{ kind: 'patient', to: (id) => `patients/${id}` }],
  nav: { icon: Users, order: 20, requires: ['patient:read'] },
  permissions: ['patient:read', 'patient:create', 'patient:update', 'patient.contact:read'],
  // This feature's own button on its own screen, added the way any feature would add one.
  extensions: [
    {
      slot: 'patient.detail.actions',
      component: () => import('./components/EditAction'),
      requires: ['patient:update'],
    },
  ],
};
