import { CalendarClock } from 'lucide-react';
import type { FeatureManifest } from '@/registry';

/**
 * Appointments: who is seen by which doctor, and when. The list (#70), booking (#71) and one
 * doctor's day or week as a calendar (#72); the changes of status (#73) follow. It chooses the doctor from the doctors
 * feature when that is on, and names a patient by id only, opening the patient's own screen.
 *
 * It hosts the `appointment.row.badges` slot (each row's badges, given the appointment's id) and
 * the `appointment.form.fields` slot (fields of other features on the booking form, given the
 * chosen doctor's id and the day).
 */
export const appointmentsFeature: FeatureManifest = {
  id: 'appointments',
  titleKey: 'title',
  i18n: {
    titles: { en: { title: 'Appointments' } },
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
      lazy: () => import('./routes/AppointmentCalendar'),
      requires: ['appointment:read'],
    },
    {
      path: 'appointments/new',
      lazy: () => import('./routes/AppointmentBook'),
      requires: ['appointment:create'],
    },
  ],
  nav: { icon: CalendarClock, order: 25, requires: ['appointment:read'] },
  permissions: ['appointment:read', 'appointment:create', 'appointment:update'],
};
