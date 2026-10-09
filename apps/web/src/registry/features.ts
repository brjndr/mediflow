import { noticesFeature } from '@/features/notices';
import { uiExamplesFeature } from '@/features/ui-examples';
import type { FeatureManifest } from './types';

/**
 * The registration point. Adding a feature is one import and one line here, and nothing else in
 * core changes: routes, navigation and slot content all come from the manifest.
 */
export const features: FeatureManifest[] = [noticesFeature, uiExamplesFeature];
