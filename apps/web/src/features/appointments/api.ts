import { api, requireData } from '@/shared/api';
import type { DayString } from '@/shared/utils/timezone';
import { appointmentPageSchema, appointmentSchema, freeSlotsSchema } from './schemas';
import type {
  Appointment,
  AppointmentCancel,
  AppointmentCreate,
  AppointmentPage,
  AppointmentReschedule,
  AppointmentStatus,
  FreeSlots,
} from './types';

export interface AppointmentFilters {
  /** Calendar days at the hospital, both included. Days and ids only: nothing about a patient. */
  from: DayString;
  to: DayString;
  /** Empty: every doctor. */
  doctorId: string;
  /** Empty: every status. */
  status: AppointmentStatus | '';
}

export async function fetchAppointments(
  {
    from,
    to,
    doctorId,
    status,
    cursor,
    limit,
  }: AppointmentFilters & {
    cursor?: string;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<AppointmentPage> {
  const result = await api.GET('/appointments', {
    params: {
      query: {
        from,
        to,
        doctorId: doctorId || undefined,
        status: status || undefined,
        cursor,
        limit,
      },
    },
    signal,
  });
  return appointmentPageSchema.parse(requireData(result));
}

/**
 * A doctor's free slots on a day at the hospital. The server works them out from the doctor's
 * working hours and what is booked: the browser never decides that a time is free.
 */
export async function fetchFreeSlots(
  { doctorId, day }: { doctorId: string; day: DayString },
  signal?: AbortSignal,
): Promise<FreeSlots> {
  const result = await api.GET('/appointments/free-slots', {
    params: { query: { doctorId, day } },
    signal,
  });
  return freeSlotsSchema.parse(requireData(result));
}

/**
 * Books an appointment. The idempotency key makes a retry or a double click return the first
 * result, not a second booking. A slot taken meanwhile is refused with 409 `slot_taken`.
 */
export async function createAppointment(
  body: AppointmentCreate,
  idempotencyKey: string,
): Promise<Appointment> {
  const result = await api.POST('/appointments', {
    body,
    params: { header: { 'idempotency-key': idempotencyKey } },
  });
  return appointmentSchema.parse(requireData(result));
}

/** One appointment, with the reason for the visit. The API audits the read. */
export async function fetchAppointment(id: string, signal?: AbortSignal): Promise<Appointment> {
  const result = await api.GET('/appointments/{appointmentId}', {
    params: { path: { appointmentId: id } },
    signal,
  });
  return appointmentSchema.parse(requireData(result));
}

/**
 * A change of an appointment, each made from the version it was looked at in. Only a scheduled
 * appointment changes, by the server's rules: a final status gives 409 `invalid_transition`,
 * a newer version 409 `conflict`.
 */
export type AppointmentChange =
  | { kind: 'reschedule'; body: AppointmentReschedule }
  | { kind: 'cancel'; body: AppointmentCancel }
  | { kind: 'complete'; body: { version: number } }
  | { kind: 'no_show'; body: { version: number } };

export async function changeAppointment(
  id: string,
  change: AppointmentChange,
  idempotencyKey: string,
): Promise<Appointment> {
  const params = {
    path: { appointmentId: id },
    header: { 'idempotency-key': idempotencyKey },
  };
  let result;
  switch (change.kind) {
    case 'reschedule':
      result = await api.POST('/appointments/{appointmentId}/reschedule', {
        params,
        body: change.body,
      });
      break;
    case 'cancel':
      result = await api.POST('/appointments/{appointmentId}/cancel', {
        params,
        body: change.body,
      });
      break;
    case 'complete':
      result = await api.POST('/appointments/{appointmentId}/complete', {
        params,
        body: change.body,
      });
      break;
    case 'no_show':
      result = await api.POST('/appointments/{appointmentId}/no-show', {
        params,
        body: change.body,
      });
      break;
  }
  return appointmentSchema.parse(requireData(result));
}
