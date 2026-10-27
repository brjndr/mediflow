// Public surface of the feature. Other features and core import from here only.
export { servicesFeature } from './manifest';
export { ServiceSearch } from './components/ServiceSearch';
export { useServiceOptions, type ServiceOption } from './hooks/use-service-options';
export type { Service, ServiceCategory, ServicePrice } from './types';
// A typed amount in minor units, on its digits (CLAUDE.md, Dates and money), for the batch prices of stock (#102).
export { currencyDigits, toMinor } from './schemas';
