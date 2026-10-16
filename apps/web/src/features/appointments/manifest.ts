import { CalendarClock } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Appointments: who is seen by which doctor, and when. The list (#70), booking (#71), one
 * doctor's day or week as a calendar (#72), and the appointment's own screen, where it is moved,
 * cancelled, completed or marked a no-show (#73). It chooses the doctor from the doctors feature
 * when that is on, and names a patient by id only, opening the patient's own screen.
 *
 * It hosts the `appointment.row.badges` slot (each row's badges, given the appointment's id) and
 * the `appointment.form.fields` slot (fields of other features on the booking form, given the
 * chosen doctor's id and the day).
 */
export const appointmentsFeature: FeatureManifest = {
  id: 'appointments',
  titleKey: 'title',
  i18n: {
    titles: {
      en: {
        title: 'Appointments',
        calendar: 'Appointment calendar',
        book: 'Book an appointment',
        record: 'Appointment',
      },
    },
    load: (language) => import(`./locales/${language}.json`),
  },
  // Off by default. A platform admin enables it per hospital.
  featureFlag: 'appointments',
  routes: [
    {
      path: 'appointments',
      lazy: () => import('./routes/AppointmentList'),
      requires: ['appointment:read'],
    },
    {
      path: 'appointments/calendar',
      titleKey: 'calendar',
      lazy: () => import('./routes/AppointmentCalendar'),
      requires: ['appointment:read'],
    },
    {
      path: 'appointments/new',
      titleKey: 'book',
      lazy: () => import('./routes/AppointmentBook'),
      requires: ['appointment:create'],
    },
    {
      // Changing it needs `appointment:update`, checked on the screen for each action.
      path: 'appointments/:appointmentId',
      titleKey: 'record',
      lazy: () => import('./routes/AppointmentDetail'),
      requires: ['appointment:read'],
    },
  ],
  nav: { icon: CalendarClock, order: 25, requires: ['appointment:read'] },
  permissions: ['appointment:read', 'appointment:create', 'appointment:update'],
};
