import { HeartPulse } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Nursing and ward care (#157, R2). The nursing worklist: the patients now on the wards, by ward,
 * and the vital signs chart of a stay with its trend, an early warning score and corrections, and
 * the medication chart (#158): the doses due, each charted given, withheld, refused or missed,
 * and the doctor's round list with progress notes and the orders of the stay (#159), fluid
 * intake and output with totals for each shift, and care plans with tasks (#160), diet orders and the kitchen list (#161).
 * Built on the nursing API (BE-24); it refers to admissions by id.
 */
export const nursingFeature: FeatureManifest = {
  id: 'nursing',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Ward care',
        vitals: 'Vital signs',
        mar: 'Medication chart',
        rounds: 'Doctor rounds',
        notes: 'Progress notes',
        fluids: 'Fluid balance',
        care: 'Care plans',
        kitchen: 'Kitchen list',
        diet: 'Diet orders',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital (it also needs `admissions`).
  featureFlag: 'nursing',
  routes: [
    {
      path: 'nursing',
      lazy: () => import('./routes/Worklist'),
      requires: ['admission:read', 'nursingVitals:read'],
    },
    {
      path: 'nursing/:admissionId/vitals',
      titleKey: 'vitals',
      lazy: () => import('./routes/WardVitals'),
      requires: ['admission:read', 'nursingVitals:read'],
    },
    {
      path: 'nursing/:admissionId/mar',
      titleKey: 'mar',
      lazy: () => import('./routes/Mar'),
      requires: ['admission:read', 'mar:read'],
    },
    {
      path: 'nursing/rounds',
      titleKey: 'rounds',
      lazy: () => import('./routes/Rounds'),
      requires: ['admission:read', 'progressNote:read'],
    },
    {
      path: 'nursing/:admissionId/notes',
      titleKey: 'notes',
      lazy: () => import('./routes/Notes'),
      requires: ['admission:read', 'progressNote:read'],
    },
    {
      path: 'nursing/:admissionId/fluids',
      titleKey: 'fluids',
      lazy: () => import('./routes/Fluids'),
      requires: ['admission:read', 'fluidBalance:read'],
    },
    {
      path: 'nursing/:admissionId/care-plan',
      titleKey: 'care',
      lazy: () => import('./routes/CarePlans'),
      requires: ['admission:read', 'carePlan:read'],
    },
    {
      path: 'nursing/kitchen',
      titleKey: 'kitchen',
      lazy: () => import('./routes/KitchenList'),
      requires: ['admission:read', 'order:read'],
    },
    {
      path: 'nursing/:admissionId/diet',
      titleKey: 'diet',
      lazy: () => import('./routes/Diet'),
      requires: ['admission:read', 'order:read'],
    },
  ],
  nav: { icon: HeartPulse, order: 82.5, requires: ['admission:read', 'nursingVitals:read'] },
  permissions: [
    'admission:read',
    'nursingVitals:read',
    'nursingVitals:record',
    'mar:read',
    'mar:record',
    'progressNote:read',
    'progressNote:write',
    'fluidBalance:read',
    'fluidBalance:record',
    'carePlan:read',
    'carePlan:write',
    'order:read',
    'order:create',
  ],
};
