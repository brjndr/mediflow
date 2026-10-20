// Public surface of the feature. Other features and core import from here only.
export { followUpsFeature } from './manifest';
// The consultation's follow-up (#88), given the encounter's id and whether it is open.
export { FollowUpPanel, type FollowUpPanelProps } from './components/FollowUpPanel';
export type { FollowUp, FollowUpState } from './types';
