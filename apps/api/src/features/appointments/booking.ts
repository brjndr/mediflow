import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../core/http/errors.js';
import {
  insertAppointment,
  patientExists,
  practisingDoctor,
  slotAt,
  type Visibility,
} from './repository.js';

/** The refusal for a booking the exclusion constraints turned down, or the error itself. */
export function bookingRefusal(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code !== '23P01') return error;
  if (constraint === 'appointments_doctor_free') {
    return new HttpError(409, 'slot_taken', 'The doctor is booked at that time');
  }
  if (constraint === 'appointments_patient_free') {
    return new HttpError(409, 'patient_overlap', 'The patient is booked at that time');
  }
  return error;
}

export interface Booking {
  patientId: string;
  doctorId: string;
  startsAt: string;
  reason: string | null;
}

/**
 * Books an appointment in the request's transaction, with a doctor `visibility` reaches (the
 * caller's scope of `appointment:create`), at one of the doctor's slots: the rules and refusals of
 * `POST /appointments` (422 `unknown_patient`, `unknown_doctor`, `outside_hours`; 409 `slot_taken`,
 * `patient_overlap`). Audits the booking and emits `appointment.created`. The new id.
 */
export async function bookAppointment(
  request: FastifyRequest,
  booking: Booking,
  visibility: Visibility,
): Promise<string> {
  if (!(await patientExists(request.txClient, booking.patientId))) {
    throw new HttpError(422, 'unknown_patient', 'No such patient');
  }
  const doctor = await practisingDoctor(request.txClient, booking.doctorId, visibility);
  if (!doctor) throw new HttpError(422, 'unknown_doctor', 'No such doctor');
  const slot = await slotAt(request.txClient, doctor, booking.startsAt);
  if (!slot) throw new HttpError(422, 'outside_hours', 'Not a slot of the working hours');
  let id: string;
  try {
    id = await insertAppointment(
      request.txClient,
      { patientId: booking.patientId, doctorId: doctor.id, slot, reason: booking.reason },
      visibility.userId,
    );
  } catch (error) {
    throw bookingRefusal(error);
  }
  request.audit('create', 'appointment', id);
  await request.emit('appointment.created', id, {
    appointmentId: id,
    patientId: booking.patientId,
    doctorId: doctor.id,
    startsAt: slot.starts_at.toISOString(),
  });
  return id;
}
