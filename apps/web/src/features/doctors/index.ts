// Public surface of the feature. Other features and core import from here only.
export { doctorsFeature } from './manifest';
export type { Doctor, DoctorAvailability, DoctorSession } from './types';
export { useDoctorOptions, type DoctorOption } from './hooks/use-doctor-options';
