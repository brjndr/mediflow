import { api, requireData } from '@/shared/api';
import type { DayString } from '@/shared/utils/timezone';
import { appointmentPageSchema } from './schemas';
import type { AppointmentPage, AppointmentStatus } from './types';

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
