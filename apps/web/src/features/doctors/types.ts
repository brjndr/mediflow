import type { components } from '@mediflow/contract';

/** A doctor profile: a staff member of one hospital (`tenantId`), in one department. */
export type Doctor = components['schemas']['Doctor'];
export type DoctorPage = components['schemas']['DoctorPage'];
export type DoctorCreate = components['schemas']['DoctorCreate'];
export type DoctorUpdate = components['schemas']['DoctorUpdate'];
/** A staff member who has no doctor profile yet. */
export type DoctorCandidate = components['schemas']['DoctorCandidate'];
export type DoctorCandidatePage = components['schemas']['DoctorCandidatePage'];
export type DoctorSession = components['schemas']['DoctorSession'];
export type DoctorAvailability = components['schemas']['DoctorAvailability'];
export type Weekday = DoctorSession['day'];
