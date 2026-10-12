import { Building2 } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Departments: the hospital's own list (Cardiology, Paediatrics), which doctors, appointments and
 * encounters refer to by id. Reference data, with no patient data in it.
 */
export const departmentsFeature: FeatureManifest = {
  id: 'departments',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Departments' } },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'departments',
  routes: [
    {
      path: 'departments',
      lazy: () => import('./routes/DepartmentsPage'),
      requires: ['department:read'],
    },
  ],
  nav: { icon: Building2, order: 30, requires: ['department:read'] },
  permissions: ['department:read', 'department:manage'],
};
