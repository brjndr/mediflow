// Public surface of the feature. Other features and core import from here only.
export { inventoryFeature } from './manifest';
// The places in use, for the pharmacy's choice of where to dispense from (#100).
export { useLocations, usePlaces } from './hooks/use-inventory';
export type { StockLocation } from './types';
