import type { FastifyPluginAsync } from 'fastify';
import { APPOINTMENT_PERMISSIONS } from './permissions.js';
import { appointmentRoutes } from './routes.js';

/**
 * Appointments: a patient booked with a doctor at one of the doctor's free slots, then moved,
 * cancelled, completed or marked a no-show. Behind the `appointments` module flag. Reads the
 * hospital's patients and doctors; publishes `appointment.*` events.
 */
export const appointmentsFeature: FastifyPluginAsync = async (app) => {
  app.permissions.register('appointments', APPOINTMENT_PERMISSIONS);
  await app.register(appointmentRoutes);
};

/** For the queue: an appointment of today whose patient has arrived, to check them in. */
export { appointmentForCheckIn, type CheckInAppointment } from './repository.js';
