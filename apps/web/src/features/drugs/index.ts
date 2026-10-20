// Public surface of the feature. Other features and core import from here only.
export { drugsFeature } from './manifest';
// A search box for a medicine to prescribe, and how a medicine reads (#81).
export { DrugSearch } from './components/DrugSearch';
export { useMedicineName } from './hooks/use-medicine-name';
export type { Drug, DrugForm, DrugSchedule, DrugType } from './types';
