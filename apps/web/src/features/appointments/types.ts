import type { components } from '@mediflow/contract';

/** An appointment as a list shows it, at one hospital (`tenantId`). Not the whole record. */
export type AppointmentSummary = components['schemas']['AppointmentSummary'];
export type AppointmentPage = components['schemas']['AppointmentPage'];
export type AppointmentStatus = components['schemas']['AppointmentStatus'];
/** An appointment record: what a list shows, and the reason for the visit. */
export type Appointment = components['schemas']['Appointment'];
export type AppointmentCreate = components['schemas']['AppointmentCreate'];
/** A doctor's free slots on one day at the hospital, worked out by the server. */
export type FreeSlots = components['schemas']['FreeSlots'];
export type TimeSlot = components['schemas']['TimeSlot'];
