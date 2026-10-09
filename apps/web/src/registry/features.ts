import type { FeatureManifest } from './types';

/**
 * The registration point. Adding a feature is one import and one line here, and nothing else in
 * core changes: routes, navigation and slot content all come from the manifest.
 *
 *   import { patientsFeature } from '@/features/patients';
 *   export const features: FeatureManifest[] = [patientsFeature];
 */
export const features: FeatureManifest[] = [];
