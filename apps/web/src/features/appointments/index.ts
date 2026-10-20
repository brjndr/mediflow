// Public surface of the feature. Other features and core import from here only.
export { appointmentsFeature } from './manifest';
export type { AppointmentStatus, AppointmentSummary } from './types';
// For booking through another feature's route (a follow-up, #88): the free times of the doctor
// and day in the form's `doctorId` and `day`, chosen into `startsAt`, and the days offered.
export { SlotPicker, type SlotRefusal } from './components/SlotPicker';
export { useAppointmentsChanged } from './hooks/use-book-appointment';
export { BOOK_AHEAD_DAYS, bookableDays } from './schemas';
