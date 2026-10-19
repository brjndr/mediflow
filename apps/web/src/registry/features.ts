import { appointmentsFeature } from '@/features/appointments';
import { codesFeature } from '@/features/codes';
import { departmentsFeature } from '@/features/departments';
import { doctorsFeature } from '@/features/doctors';
import { drugsFeature } from '@/features/drugs';
import { importsFeature } from '@/features/imports';
import { labTestsFeature } from '@/features/lab-tests';
import { noticesFeature } from '@/features/notices';
import { patientsFeature } from '@/features/patients';
import { queueFeature } from '@/features/queue';
import { servicesFeature } from '@/features/services';
import { staffFeature } from '@/features/staff';
import { templatesFeature } from '@/features/templates';
import { triageFeature } from '@/features/triage';
import { uiExamplesFeature } from '@/features/ui-examples';
import { wardsFeature } from '@/features/wards';
import type { FeatureManifest } from './types';

/**
 * The registration point. Adding a feature is one import and one line here, and nothing else in
 * core changes: routes, navigation and slot content all come from the manifest.
 *
 * `e2e/a11y.spec.ts` reads this file as text to find every route: keep one
 * `import { xFeature } from '@/features/<folder>';` per feature and a plain list below.
 */
export const features: FeatureManifest[] = [
  noticesFeature,
  uiExamplesFeature,
  patientsFeature,
  departmentsFeature,
  doctorsFeature,
  servicesFeature,
  drugsFeature,
  labTestsFeature,
  wardsFeature,
  codesFeature,
  templatesFeature,
  importsFeature,
  appointmentsFeature,
  queueFeature,
  triageFeature,
  staffFeature,
];
