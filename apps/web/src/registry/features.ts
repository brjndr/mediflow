import { codesFeature } from '@/features/codes';
import { departmentsFeature } from '@/features/departments';
import { doctorsFeature } from '@/features/doctors';
import { drugsFeature } from '@/features/drugs';
import { labTestsFeature } from '@/features/lab-tests';
import { noticesFeature } from '@/features/notices';
import { patientsFeature } from '@/features/patients';
import { servicesFeature } from '@/features/services';
import { staffFeature } from '@/features/staff';
import { templatesFeature } from '@/features/templates';
import { uiExamplesFeature } from '@/features/ui-examples';
import { wardsFeature } from '@/features/wards';
import type { FeatureManifest } from './types';

/**
 * The registration point. Adding a feature is one import and one line here, and nothing else in
 * core changes: routes, navigation and slot content all come from the manifest.
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
  staffFeature,
];
