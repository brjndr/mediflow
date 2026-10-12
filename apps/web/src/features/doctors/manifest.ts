import { Stethoscope } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Doctors: a staff member's profile as a doctor (department, specialization, how long an
 * appointment takes) and their regular weekly working hours, which scheduling reads. It chooses
 * the department from the departments feature, so a hospital needs that switched on as well.
 */
export const doctorsFeature: FeatureManifest = {
  id: 'doctors',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Doctors' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'doctors',
  routes: [
    { path: 'doctors', lazy: () => import('./routes/DoctorList'), requires: ['doctor:read'] },
    {
      path: 'doctors/new',
      lazy: () => import('./routes/DoctorCreate'),
      requires: ['doctor:manage'],
    },
    {
      path: 'doctors/:doctorId',
      lazy: () => import('./routes/DoctorDetail'),
      requires: ['doctor:read'],
    },
  ],
  nav: { icon: Stethoscope, order: 40, requires: ['doctor:read'] },
  permissions: ['doctor:read', 'doctor:manage'],
};
