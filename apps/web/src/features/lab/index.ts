// Public surface of the feature. Other features and core import from here only.
export { labFeature } from './manifest';
// The consultation's lab results (#92), given the encounter and its patient; it checks
// `labResult:read` and the switch itself.
export { LabResultsPanel, type LabResultsPanelProps } from './components/LabResultsPanel';
