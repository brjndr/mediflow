// Public surface of the feature. Other features and core import from here only.
export { drugsFeature } from './manifest';
// A search box for a medicine to prescribe, and how a medicine reads (#81).
export { DrugSearch } from './components/DrugSearch';
export { useMedicineName } from './hooks/use-medicine-name';
export type { Drug, DrugForm, DrugSchedule, DrugType } from './types';
// A star for a medicine, and the caller's favourites that `DrugSearch` offers first (#394).
export { FavouriteToggle } from './components/FavouriteToggle';
// Reading and unstarring the caller's favourites, for the list that manages them (#485).
export { useFavouriteDrugs, useToggleFavourite } from './hooks/use-favourites';
