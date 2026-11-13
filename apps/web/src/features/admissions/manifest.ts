import { BedSingle } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Admissions, discharge and transfer (R2). The bed board (#151): every bed in use by ward and
 * status, who is in it, kept live by the server's events, with cleaning and ready marked by
 * housekeeping and blocking from the wards API. The admission workflow (#152): the admissions
 * list, admitting a patient into a free bed (which opens the stay's inpatient encounter) and
 * giving or changing a bed. It refers to wards, doctors and patients by id.
 */
export const admissionsFeature: FeatureManifest = {
  id: 'admissions',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Bed board',
        admissions: 'Admissions',
        admit: 'Admit a patient',
        census: 'Inpatient census',
        summary: 'Discharge summary',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital (it also needs `wards`).
  featureFlag: 'admissions',
  routes: [
    { path: 'beds', lazy: () => import('./routes/BedBoard'), requires: ['admission:read'] },
    {
      path: 'admissions',
      titleKey: 'admissions',
      lazy: () => import('./routes/Admissions'),
      requires: ['admission:read'],
    },
    {
      path: 'census',
      titleKey: 'census',
      lazy: () => import('./routes/Census'),
      requires: ['admission:read'],
    },
    {
      path: 'admissions/:admissionId/summary',
      titleKey: 'summary',
      lazy: () => import('./routes/DischargeSummary'),
      requires: ['dischargeSummary:read'],
    },
    {
      path: 'admissions/new',
      titleKey: 'admit',
      lazy: () => import('./routes/AdmitPatient'),
      requires: ['admission:create'],
    },
  ],
  nav: { icon: BedSingle, order: 81, requires: ['admission:read'] },
  dashboardWidgets: [
    {
      id: 'capacity',
      component: () => import('./components/CapacityWidget'),
      requires: ['admission:read'],
      size: 'sm',
    },
  ],
  extensions: [
    // "Admit to hospital" (#576), given ids and the visit's status only.
    {
      slot: 'patient.detail.actions',
      component: () => import('./components/AdmitAction'),
      requires: ['admission:create'],
      order: 30,
    },
    {
      slot: 'encounter.detail.actions',
      component: () => import('./components/AdmitAction'),
      requires: ['admission:create'],
      order: 30,
    },
    {
      slot: 'emergency.case.actions',
      component: () => import('./components/AdmitAction'),
      requires: ['admission:create'],
      order: 30,
    },
  ],
  permissions: [
    'admission:read',
    'admission:create',
    'admission:transfer',
    'admission:discharge',
    'dischargeSummary:read',
    'dischargeSummary:create',
    'dischargeSummary:sign',
    'bed:update',
    'bed:reserve',
  ],
};
