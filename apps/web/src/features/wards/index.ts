// Public surface of the feature. Other features and core import from here only.
export { wardsFeature } from './manifest';
export type { Bed, BedCategory, BedStatus, Room, Ward } from './types';
// The bed categories with their bed-day service, for the bed picker of admissions (#578).
export { useBedCategories } from './hooks/use-wards';
